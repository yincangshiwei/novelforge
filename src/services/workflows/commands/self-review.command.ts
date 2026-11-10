/**
 * SelfReviewCommand — 迭代式自省（终审 Agent）
 *
 * 流程（最多 2 轮）：
 *   初稿 → 审计报告（六类审计，复用定稿审计上下文）→ 终审 Agent 给 1.2.3. 修改建议清单
 *   → 主 AI 根据清单重写 → 再次审计 → 循环。
 *
 * 安全设计：重写稿保存为**新版本草稿**（source='rewrite'），不覆盖初稿——
 * 可追溯、可与初稿对比；重写稿过短（< 初稿 50%）判定异常放弃本轮。
 */
import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { t } from '../../../shared/locale'
import { ipc } from '../../ipc-client'
import { computeTextStats } from '../../text-stats'

/** 终审 Agent systemRole：只审不改，输出可执行的修改建议 */
const getReviewerSystem = (): string => t('prompt.selfReview.reviewerSystem')

/** 重写 Agent systemRole：落实建议的写手 */
const getRewriterSystem = (): string => t('prompt.selfReview.rewriterSystem')

export class SelfReviewCommand extends BaseWorkflowCommand<void> {
  constructor(private params: {
    chapterNumber: number
    chapterTitle: string
    /** 初稿草稿 id（写稿步骤产出） */
    draftId: number
  }) {
    super()
  }

  async execute({ callbacks }: CommandExecuteParams): Promise<void> {
    const { collectAuditContext, auditText } = await import('../../audit/audit-context')
    const ctx = await collectAuditContext(this.params.chapterNumber)

    // 读初稿（写稿步骤最新版本）
    const full = await ipc.invoke('db:draft-get-full', this.params.draftId) as { content?: string } | null
    if (!full?.content || !full.content.trim()) {
      callbacks.log(t('log.selfReview.unreadable'))
      return
    }

    const { readWritingConstraints } = await import('../../writing-constraints')
    const constraints = await readWritingConstraints({ chapterNumber: this.params.chapterNumber, text: full.content })
    let current = full.content
    let rewrote = false
    let rounds = 0

    for (let round = 1; round <= 2; round++) {
      rounds = round
      const audit = auditText(ctx, current)
      if (audit.passed) {
        callbacks.log(t('log.selfReview.passed').replace('{round}', String(round)))
        break
      }
      callbacks.log(t('log.selfReview.issuesFound')
        .replace('{round}', String(round))
        .replace('{count}', String(audit.issues.length))
        .replace('{summary}', audit.summary))

      // ===== 1. 终审 Agent：审计报告 → 修改建议清单 =====
      const issueText = audit.issues
        .map((iss, i) => `${i + 1}. [${iss.kind}]${iss.position ? ` (${iss.position})` : ''} ${iss.message}`)
        .join('\n')
      // 靶向采样：若全文 > 4500 字，除首尾段外，额外提取 audit.issues 标出的问题段落（防止中段 AI 味问题在 [中段略] 中不可见）
      let draftPreview: string
      if (current.length <= 4500) {
        draftPreview = current
      } else {
        const paragraphs = current.split(/\n\s*\n+/).map(p => p.trim()).filter(Boolean)
        const hitIndices = new Set<number>()
        for (const iss of audit.issues) {
          for (const m of (iss.position ?? '').matchAll(/第(\d+)段/g)) {
            const idx = parseInt(m[1], 10) - 1
            if (idx >= 0 && idx < paragraphs.length) hitIndices.add(idx)
          }
        }
        const targetedSnippets = [...hitIndices]
          .sort((a, b) => a - b)
          .slice(0, 6)
          .map(idx => `[第${idx + 1}段] ${paragraphs[idx]}`)
          .join('\n\n')
        draftPreview = current.slice(0, 1500)
          + (targetedSnippets ? `\n\n[审计命中问题段落摘录]\n${targetedSnippets}\n\n` : '\n\n[中段略]...\n\n')
          + current.slice(-2500)
      }
      const reviewerPrompt =
        constraints + '\n\n' + t('prompt.selfReview.reviewerTitle') + '\n' + issueText + '\n\n' +
        t('prompt.selfReview.draftPreviewTitle') + '\n' + draftPreview + '\n\n' +
        t('prompt.selfReview.reviewerTask')
      // ⚠️ M 级修复：审稿人路由到独立审稿模型（purpose 分派——同模型自审对判断类纠错效果有限）
      const suggestions = await this.callLLM(reviewerPrompt, getReviewerSystem(), callbacks, { purpose: 'review_chapter' })
      if (!suggestions.trim()) {
        callbacks.log(t('log.selfReview.noSuggestions'))
        break
      }
      callbacks.log(t('log.selfReview.suggestions')
        .replace('{suggestions}', suggestions.slice(0, 500) + (suggestions.length > 500 ? '…' : '')))

      // ===== 2. 主 AI 根据清单重写 =====
      const rewritePrompt =
        constraints + '\n\n' + t('prompt.selfReview.suggestionTitle') + '\n' + suggestions + '\n\n' +
        t('prompt.selfReview.fullDraftTitle') + '\n' + current + '\n\n' +
        t('prompt.selfReview.rewriteTask')
      const rewritten = await this.callLLM(rewritePrompt, getRewriterSystem(), callbacks)

      // 防御：重写稿异常（过短 = 截断/拒答）→ 放弃本轮，保留当前稿
      if (rewritten.trim().length < current.trim().length * 0.5) {
        callbacks.log(t('log.selfReview.rewriteTooShort'))
        break
      }
      // ⚠️ M 级修复：关键情节保留检查——重写稿可悄悄删掉/篡改关键事件而不被拦截；
      //   取本章蓝图 keyEvents 关键词，重写稿命中不足半数则放弃本轮（确定性闸门）
      try {
        const bp = await ipc.invoke('db:blueprint-get', this.params.chapterNumber) as { keyEvents?: string } | null
        if (bp?.keyEvents) {
          const keywords = String(bp.keyEvents)
            .split(/[，,。；;、\s]+/)
            .filter(s => s.length >= 2)
            .slice(0, 5)
          if (keywords.length > 0) {
            const hit = keywords.filter(k => rewritten.includes(k)).length
            if (hit < Math.max(1, Math.ceil(keywords.length / 2))) {
              callbacks.log(t('log.selfReview.keyEventsLost').replace('{hit}', String(hit)).replace('{total}', String(keywords.length)))
              break
            }
          }
        }
      } catch { /* 蓝图读取失败不阻断 */ }
      current = rewritten
      rewrote = true
    }

    const finalAudit = auditText(ctx, current)
    callbacks.log(t('log.selfReview.finalAudit').replace('{summary}', finalAudit.summary))
    if (!finalAudit.passed) {
      callbacks.log(finalAudit.issues.map(issue => [issue.position, issue.message].filter(Boolean).join('：')).join('\n'))
    }

    // ===== 3. 落库：重写稿另存新版本（不覆盖初稿） =====
    if (rewrote) {
      const latest = await ipc.invoke('db:draft-get-latest', this.params.chapterNumber) as { version?: number } | null
      const nextVersion = (latest?.version ?? 1) + 1
      await ipc.invoke('db:draft-create', {
        chapterNumber: this.params.chapterNumber,
        version: nextVersion,
        content: current,
        wordCount: computeTextStats(current).novelWordCount,
        source: 'rewrite',
      })
      callbacks.log(t('log.selfReview.rewriteSaved').replace('{version}', String(nextVersion)))
      const { globalEventBus } = await import('../../../shared/event-bus')
      globalEventBus.emit('REFRESH_RESOURCE', { resources: ['drafts'] })
    } else {
      callbacks.log(t('log.selfReview.done').replace('{rounds}', String(rounds)))
    }
  }
}
