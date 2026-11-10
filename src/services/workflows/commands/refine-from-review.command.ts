import { t } from '../../../shared/locale'
import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { getPromptTemplate } from '../../prompt-templates'
import { ChapterPromptBuilder } from '../../prompts/prompt-builder'
import { computeTextStats } from '../../text-stats'
import { ipc } from '../../ipc-client'


export interface RefineFromReviewParams {
  draftPath: string
  draftContent: string
  reviewReport: string
  reviewFileName?: string
  chapterNumber: number
  userRefinePrompt?: string
  localOnly?: boolean
}

export class RefineFromReviewCommand extends BaseWorkflowCommand<string> {
  constructor(private params: RefineFromReviewParams) {
    super()
  }

  async execute({ callbacks, context }: CommandExecuteParams): Promise<string> {
    this.throwIfCancelled(context)
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error(t('error.noProject'))

    callbacks.log(t('log.refineFromReview.starting'))

    const template = getPromptTemplate('refine_from_review')
    if (!template) throw new Error(t('error.templateNotFound').replace('{name}', '审稿修复'))

    const userPromptBlock = this.params.userRefinePrompt?.trim()
      ? `★【用户额外修稿指导（绝对优先级）】★：\n${this.params.userRefinePrompt}`
      : ''

    const promptBuilder = new ChapterPromptBuilder(template)
      .withReviewReport(this.params.reviewReport)
      .withDraftContent(this.params.draftContent)
      .withGlobalGuidance(project.novelConfig.globalGuidance || '')
      .withUserRefinePrompt(userPromptBlock)

    const { readWritingConstraints } = await import('../../writing-constraints')
    const constraints = await readWritingConstraints({ chapterNumber: this.params.chapterNumber, text: this.params.draftContent, includeGlobal: false })
    const { parseDraftMeta } = await import('../chapter-workflow')
    const baseDraft = await parseDraftMeta(this.params.draftPath)
    if (!baseDraft || baseDraft.status === 'finalized' || baseDraft.status === 'archived') throw new Error(t('tool.draftReadonly'))
    const { isReviewCurrent, locateReviewEdits, applyReviewEdits } = await import('../../review-actions')
    const full = await ipc.invoke('db:draft-get-full', baseDraft.id)
    if (!full || full.content !== this.params.draftContent || !await isReviewCurrent(this.params.reviewReport, baseDraft.id, full.content)) {
      throw new Error(t('review.staleReport'))
    }
    let cleanRefined: string
    if (this.params.localOnly) {
      const { parseReport } = await import('../../../components/editor/review-report-parser')
      const issues = parseReport(this.params.reviewReport).issues.filter(issue => issue.severity !== 'pass')
      if (!issues.length) throw new Error(t('review.noExactQuote'))
      const spans = locateReviewEdits(full.content, issues)
      const edits = []
      for (const span of spans) {
        this.throwIfCancelled(context)
        const request = JSON.stringify({
          issue: span.issue, excerpt: span.quote,
          contextBefore: full.content.slice(Math.max(0, span.start - 200), span.start),
          contextAfter: full.content.slice(span.end, span.end + 200),
          instruction: this.params.userRefinePrompt || '',
        })
        const replacement = this.stripThinkingTags(await this.callLLM(
          constraints + '\n\n' + request,
          t('review.localFixSystem'), callbacks, { purpose: 'refine_chapter' },
        )).trim()
        if (!replacement || replacement.startsWith('```')) throw new Error(t('review.ambiguousQuote'))
        edits.push({ start: span.start, end: span.end, replacement })
      }
      cleanRefined = applyReviewEdits(full.content, edits)
    } else {
      cleanRefined = this.stripThinkingTags(await this.callLLM(promptBuilder.build() + '\n\n' + constraints, promptBuilder.getSystemRole(), callbacks, { purpose: 'refine_chapter' }))
    }
    this.throwIfCancelled(context)
    const latestFull = await ipc.invoke('db:draft-get-full', baseDraft.id)
    if (useProjectStore.getState().currentProject?.id !== project.id || latestFull?.content !== full.content) throw new Error(t('review.staleReport'))

    const { auditRefinement, openRefinementAudit } = await import('../../audit/refinement-audit')
    const candidateAudit = await auditRefinement(cleanRefined, baseDraft.id, baseDraft.version)
    const { reviewContentHash } = await import('../../review-actions')
    const auditReport = JSON.stringify({ ...candidateAudit, baseContentHash: await reviewContentHash(full.content), selectedIssues: JSON.parse(this.params.reviewReport).items })
    callbacks.log(candidateAudit.summary)
    const revIndex = await ipc.invoke('db:revision-next-index', baseDraft.id)

    // 清理该草稿下已有的 pending 状态修稿，保证只保留最新的一条
    const pendingRevs = await ipc.invoke('db:revision-get-pending', baseDraft.id)
    for (const rev of pendingRevs) {
      await ipc.invoke('db:revision-mark-discarded', rev.id)
    }

    const createRes = await ipc.invoke('db:revision-create', {
      baseDraftId: baseDraft.id,
      revisionIndex: revIndex,
      revisionType: 'review-fix',
      reviewSourceId: JSON.parse(this.params.reviewReport).reviewSourceId,
      auditReport,
      content: cleanRefined,
      wordCount: computeTextStats(cleanRefined).novelWordCount,
      userPrompt: this.params.userRefinePrompt,
    }) as { success: boolean; id: number }

    if (!createRes.success || !createRes.id) throw new Error(t('error.noBaseDraft'))
    openRefinementAudit(auditReport, createRes.id, this.params.chapterNumber)
    const { useEditorStore } = await import('../../../stores/editor-store')
    useEditorStore.getState().openFile({
      id: `diff-${this.params.draftPath}-${createRes.id}`,
      name: t('workflow.reviewFix').replace('{n}', String(this.params.chapterNumber)),
      type: 'diff',
      filePath: this.params.draftPath,
      originalContent: this.params.draftContent,
      content: cleanRefined,
      revisionPath: String(createRes.id),
      chapterNumber: this.params.chapterNumber,
      chapterDir: `vela://draft/ch${this.params.chapterNumber}`,
    })

    callbacks.log(t('log.refineFromReview.done')
      .replace('{chars}', String(cleanRefined.length))
      .replace('{revision}', String(revIndex)))
    return cleanRefined
  }
}
