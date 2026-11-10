import { useState, useMemo, useEffect } from 'react'
import { useProjectStore } from '../../stores/project-store'
import { getIgnoredReviewIssues, saveIgnoredReviewIssues, reviewIssueKey, isReviewCurrent, locateReviewEdits } from '../../services/review-actions'
import { AlertTriangle, CheckCircle, Info, Sparkles, HelpCircle, Quote } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useTranslation } from '../../hooks/useTranslation'
import type { TextKey } from '../../shared/locale'
import { Button } from '../ui/Button'
import { Disclosure } from '../ui/Disclosure'
import AIActionDialog from './AIActionDialog'
import { parseReport, type ReviewIssue } from './review-report-parser'

interface ReviewReportProps {
  /** 原始审稿报告文本（JSON 或旧版 markdown） */
  reportText: string
  /** 审稿报告关联的草稿路径（用于触发修稿） */
  draftPath?: string
  /** 章节号 */
  chapterNumber?: number
  /** 章节目录 */
  chapterDir?: string
}


// ===== 视觉配置 =====

type TFunc = (key: TextKey) => string

function getSeverityMeta(t: TFunc): Record<ReviewIssue['severity'], {
  label: string
  emoji: string
  actionLabel: string
  colorClass: string
  bgClass: string
  borderClass: string
}> {
  return {
    error: {
      label: t('review.critical'),
      emoji: '🔴',
      actionLabel: t('review.fixStrongly'),
      colorClass: 'text-[var(--color-error)]',
      bgClass: 'bg-[rgba(var(--color-error-rgb),0.1)]',
      borderClass: 'border-[rgba(var(--color-error-rgb),0.3)]',
    },
    warning: {
      label: t('review.suggestion'),
      emoji: '🟡',
      actionLabel: t('review.fixOptional'),
      colorClass: 'text-[var(--color-warning)]',
      bgClass: 'bg-[rgba(var(--color-warning-rgb),0.1)]',
      borderClass: 'border-[rgba(var(--color-warning-rgb),0.3)]',
    },
    pass: {
      label: t('review.passed'),
      emoji: '🟢',
      actionLabel: t('review.noAction'),
      colorClass: 'text-[var(--color-success)]',
      bgClass: 'bg-[rgba(var(--color-success-rgb),0.1)]',
      borderClass: 'border-[rgba(var(--color-success-rgb),0.3)]',
    },
  }
}

/** 审稿报告查看器 */
export default function ReviewReport({ reportText, draftPath }: ReviewReportProps) {
  const { t } = useTranslation()
  const severityMeta = useMemo(() => getSeverityMeta(t), [t])

  const { issues: rawIssues, summary, parseFailed } = parseReport(reportText)
  // 将默认分类名「综合检查」替换为本地化文本
  const comprehensiveCheckLabel = t('review.comprehensiveCheck')
  const issues = useMemo(() => rawIssues.map(issue => ({
    ...issue,
    category: issue.category === '综合检查' ? comprehensiveCheckLabel : issue.category,
  })), [rawIssues, comprehensiveCheckLabel])

  const [showRefineDialog, setShowRefineDialog] = useState(false)
  const [userRefinePrompt, setUserRefinePrompt] = useState('')
  const [processing, setProcessing] = useState(false)
  const [showLegend, setShowLegend] = useState(false)
  const projectId = useProjectStore(state => state.currentProject?.id ?? '')
  const [ignored, setIgnored] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [actionError, setActionError] = useState('')
  useEffect(() => {
    setIgnored(getIgnoredReviewIssues(reportText, projectId))
    setSelected(new Set())
    setActionError('')
  }, [reportText, projectId])
  const originalIssue = (item: ReviewIssue) => rawIssues.find(issue => issue.description === item.description && issue.quote === item.quote && issue.severity === item.severity) ?? item
  const toggleIgnore = (item: ReviewIssue) => {
    const key = reviewIssueKey(originalIssue(item))
    const next = new Set(ignored)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    try { saveIgnoredReviewIssues(reportText, projectId, next); setIgnored(next) } catch (error) { setActionError(String(error)) }
  }

  // 按分类分组
  const categories = new Map<string, ReviewIssue[]>()
  for (const issue of issues) {
    const list = categories.get(issue.category) || []
    list.push(issue)
    categories.set(issue.category, list)
  }

  // 统计
  const errorCount = issues.filter((i) => i.severity === 'error').length
  const warningCount = issues.filter((i) => i.severity === 'warning').length
  const passCount = issues.filter((i) => i.severity === 'pass').length

  const doRefineFromReview = async (chosen?: ReviewIssue[]) => {
    if (!draftPath || processing) return
    setProcessing(true)
    setActionError('')
    setShowRefineDialog(false)
    try {
      const { startWithReceipt } = await import('../../services/workflows/workflow-starter')
      const { createRefineFromReviewWorkflow, parseDraftMeta } = await import('../../services/workflows/chapter-workflow')
      const { ipc } = await import('../../services/ipc-client')
      const { useEditorStore } = await import('../../stores/editor-store')
      const meta = await parseDraftMeta(draftPath)
      if (!meta) throw new Error(t('error.noBaseDraft'))
      if (useEditorStore.getState().tabs.some(tab => tab.filePath === draftPath && tab.dirty)) throw new Error(t('tool.draftDirty'))
      const full = await ipc.invoke('db:draft-get-full', meta.id)
      if (!full || !await isReviewCurrent(reportText, meta.id, full.content)) throw new Error(t('review.staleReport'))
      const activeIssues = chosen ?? rawIssues.filter(item => item.severity !== 'pass' && !ignored.has(reviewIssueKey(item)))
      if (!activeIssues.length) return
      if (chosen) locateReviewEdits(full.content, chosen)
      const filteredReport = JSON.stringify({ ...JSON.parse(reportText), items: activeIssues })
      await startWithReceipt(createRefineFromReviewWorkflow({
        chapterNumber: meta.chapterNumber,
        chapterTitle: meta.chapterTitle || t('chapter.nLabel').replace('{n}', String(meta.chapterNumber)),
        draftPath,
        draftContent: full.content,
        reviewReport: filteredReport,
        reviewFileName: '',
        localOnly: !!chosen,
        userRefinePrompt: userRefinePrompt.trim() || undefined,
      }))
    } catch (error) {
      setActionError(t('review.fixError').replace('{error}', String(error)))
    } finally {
      setProcessing(false)
    }
  }

  const reviewAgain = async () => {
    if (!draftPath || processing) return
    setProcessing(true)
    setActionError('')
    try {
      const { parseDraftMeta, createReviewOnlyWorkflow } = await import('../../services/workflows/chapter-workflow')
      const { startWithReceipt } = await import('../../services/workflows/workflow-starter')
      const { ipc } = await import('../../services/ipc-client')
      const { useEditorStore } = await import('../../stores/editor-store')
      if (useEditorStore.getState().tabs.some(tab => tab.filePath === draftPath && tab.dirty)) throw new Error(t('tool.draftDirty'))
      const meta = await parseDraftMeta(draftPath)
      if (!meta) throw new Error(t('error.noBaseDraft'))
      const full = await ipc.invoke('db:draft-get-full', meta.id)
      if (!full?.content?.trim()) throw new Error(t('error.noDraft'))
      await startWithReceipt(createReviewOnlyWorkflow({ chapterNumber: meta.chapterNumber, chapterTitle: meta.chapterTitle || '', draftPath, draftContent: full.content }))
      setActionError(t('review.started'))
    } catch (error) {
      setActionError(t('error.reviewFailed').replace('{error}', String(error)))
    } finally { setProcessing(false) }
  }

  const SeverityIcon = ({ severity }: { severity: string }) => {
    if (severity === 'error') return <AlertTriangle size={14} className="text-[var(--color-error)] flex-shrink-0" />
    if (severity === 'warning') return <AlertTriangle size={14} className="text-[var(--color-warning)] flex-shrink-0" />
    return <CheckCircle size={14} className="text-[var(--color-success)] flex-shrink-0" />
  }

  // 是否可以触发修稿（有草稿路径和章节信息时）
  const canRefine = !!draftPath

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 py-4">
        {/* 统计栏 */}
        <div className="flex items-center gap-4 mb-4 pb-3 border-b border-[var(--color-border)]">
          <h3 className="text-base font-bold text-[var(--color-text)]">{t('review.title')}</h3>
          <div className="flex items-center gap-3 text-xs ml-auto">
            {errorCount > 0 && (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-[rgba(var(--color-error-rgb),0.2)] text-[var(--color-error)]">
                🔴 {errorCount} {t('review.criticalCount')}
              </span>
            )}
            {warningCount > 0 && (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-[rgba(var(--color-warning-rgb),0.2)] text-[var(--color-warning)]">
                🟡 {warningCount} {t('review.suggestionCount')}
              </span>
            )}
            <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-[rgba(var(--color-success-rgb),0.2)] text-[var(--color-success)]">
              🟢 {passCount} {t('review.passedCount')}
            </span>
            {/* 图例帮助按钮 */}
            <button
              className="flex items-center justify-center rounded-full hover:bg-[var(--color-hover)] transition-colors"
              style={{ width: 22, height: 22 }}
              onClick={() => setShowLegend(!showLegend)}
              title={t('tip.colorLegend')}
            >
              <HelpCircle size={14} style={{ color: 'var(--color-text-muted)' }} />
            </button>
          </div>
        </div>

        {/* 颜色图例说明 */}
        {showLegend && (
          <div
            className="mb-4 rounded-lg border p-3 text-xs space-y-2"
            style={{
              backgroundColor: 'var(--color-bg-elevated)',
              borderColor: 'var(--color-border)',
            }}
          >
            <div className="font-medium text-[var(--color-text)] mb-1.5">{t('review.colorLegend')}</div>
            {(['error', 'warning', 'pass'] as const).map(sev => {
              const meta = severityMeta[sev]
              return (
                <div key={sev} className="flex items-center gap-2">
                  <span className={cn(
                    'inline-flex items-center gap-1 px-2 py-0.5 rounded',
                    meta.bgClass, meta.colorClass
                  )}>
                    {meta.emoji} {meta.label}
                  </span>
                  <span style={{ color: 'var(--color-text-secondary)' }}>
                    — {meta.actionLabel}
                  </span>
                </div>
              )
            })}
          </div>
        )}

        {/* 总体评价（如有） */}
        {summary && (
          <div
            className="mb-4 px-4 py-3 rounded-lg border text-sm"
            style={{
              backgroundColor: 'var(--color-bg-elevated)',
              borderColor: 'var(--color-border)',
              color: 'var(--color-text)',
            }}
          >
            <span className="font-medium">{t('review.overallAssessment')}</span>
            <span style={{ color: 'var(--color-text-secondary)' }}>{summary}</span>
          </div>
        )}

        {/* 分类展示 */}
        {parseFailed ? (
          <div
            className="rounded-lg border p-4 text-sm"
            style={{
              borderColor: 'var(--color-error)',
              backgroundColor: 'rgba(var(--color-error-rgb), 0.08)',
            }}
            role="alert"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle size={16} className="text-[var(--color-error)] flex-shrink-0 mt-0.5" />
              <div>
                <div className="font-medium text-[var(--color-error)]">{t('review.parseFailed')}</div>
                <p className="mt-1 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                  {t('review.parseFailedHint')}
                </p>
              </div>
            </div>
          </div>
        ) : issues.length === 0 ? (
          <div className="text-center py-8 text-[var(--color-text-muted)] text-sm">
            <CheckCircle size={36} className="mx-auto mb-2 text-[var(--color-success)]" />
            {t('review.allPassed')}
          </div>
        ) : (
          <div className="space-y-4">
            {Array.from(categories.entries()).map(([category, items]) => (
              <div key={category}>
                <h4 className="text-sm font-semibold text-[var(--color-text)] mb-2 flex items-center gap-1.5">
                  <Info size={14} className="text-[var(--color-text-muted)]" />
                  {category}
                </h4>
                <div className="space-y-1.5 pl-1">
                  {items.map((item, i) => {
                    const meta = severityMeta[item.severity]
                    return (
                      <div
                        key={i}
                        className={cn(
                          'px-3 py-2 rounded-md border text-xs leading-relaxed',
                          meta.borderClass, meta.bgClass
                        )}
                      >
                        <div className="flex items-start gap-2">
                          <SeverityIcon severity={item.severity} />
                          <div className="flex-1 min-w-0">
                            <span className="text-[var(--color-text-secondary)]">{item.description}</span>
                            <span
                              className={cn('ml-2 text-micro opacity-70', meta.colorClass)}
                            >
                              [{meta.actionLabel}]
                            </span>
                          </div>
                        </div>
                        {/* 引用原文（如有） */}
                        {item.quote && (
                          <div
                            className="mt-1.5 ml-5 pl-2 text-micro italic"
                            style={{
                              borderLeft: '2px solid var(--color-border)',
                              color: 'var(--color-text-muted)',
                            }}
                          >
                            <Quote size={10} className="inline mr-1 opacity-60" />
                            {item.quote}
                          </div>
                        )}
                        {canRefine && item.severity !== 'pass' && (
                          <div className="mt-2 ml-5 flex flex-wrap items-center gap-2">
                            <input type="checkbox" aria-label={t('review.fixSelected')}
                              checked={selected.has(reviewIssueKey(originalIssue(item)))}
                              disabled={processing || ignored.has(reviewIssueKey(originalIssue(item)))}
                              onChange={() => {
                                const key = reviewIssueKey(originalIssue(item))
                                setSelected(prev => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next })
                              }} />
                            <Button size="sm" variant="ai" disabled={processing || ignored.has(reviewIssueKey(originalIssue(item))) || !item.quote}
                              title={!item.quote ? t('review.noExactQuote') : undefined}
                              onClick={() => void doRefineFromReview([originalIssue(item)])}>{t('review.fixOne')}</Button>
                            <Button size="sm" variant="ghost" disabled={processing} onClick={() => toggleIgnore(item)}>
                              {t(ignored.has(reviewIssueKey(originalIssue(item))) ? 'review.restoreOne' : 'review.ignoreOne')}
                            </Button>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* 原始文本折叠 —— 2026-09-28 走查：折叠头统一走 ui/Disclosure（箭头/hover 底色/扩点击区/
            次级色四要素）；此前手写 summary 是 text-xs+muted，与说明文字同款、看不出可点 */}
        <Disclosure label={t('review.rawText')} className="mt-6">
          <pre className="text-xs whitespace-pre-wrap font-mono leading-5 text-[var(--color-text-secondary)] bg-[var(--color-sidebar)] rounded-md p-3 border border-[var(--color-border)]">
            {reportText}
          </pre>
        </Disclosure>

      </div>
      </div>
        {canRefine && (
          <div className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3 shadow-[0_-4px_12px_rgba(0,0,0,0.08)] z-10">
            {actionError && (
              <div className="max-w-2xl mx-auto mb-2 flex items-center gap-2">
                <p role="alert" className="flex-1 text-sm text-[var(--color-error)]">{actionError}</p>
                <Button size="sm" variant="outline" disabled={processing} onClick={() => void reviewAgain()}>{t('review.reviewAgain')}</Button>
              </div>
            )}
            <div className="max-w-2xl mx-auto flex items-center justify-center gap-3">
              <Button variant="ai" className="flex-1 min-w-0" disabled={processing || !rawIssues.some(item => selected.has(reviewIssueKey(item)) && !ignored.has(reviewIssueKey(item)))}
                onClick={() => void doRefineFromReview(rawIssues.filter(item => selected.has(reviewIssueKey(item)) && !ignored.has(reviewIssueKey(item))))}>
                {t('review.fixSelected')}
              </Button>
              <Button
                variant="ai"
                className="flex-1 min-w-0"
                onClick={() => { setUserRefinePrompt(''); setShowRefineDialog(true) }}
                disabled={processing}
              >
                <Sparkles size={14} className="mr-1" />
                {t('review.aiFixBtn')}
              </Button>
            </div>
          </div>
        )}

      {/* 审稿修稿确认弹窗（线③ 第 3 条：复用 AIActionDialog 壳，删内联复制体） */}
      <AIActionDialog
        action={showRefineDialog ? 'refine' : null}
        refinePrompt={userRefinePrompt}
        reviewDims={{}}
        onClose={() => setShowRefineDialog(false)}
        onRefinePromptChange={setUserRefinePrompt}
        onReviewDimToggle={() => {}}
        onConfirm={doRefineFromReview}
        refineCopy={{
          titleKey: 'review.aiFixTitle',
          descKey: 'review.aiFixDesc2',
          scopeTitleKey: 'review.refineScope',
          scopeItems: ['review.refineScopeItem1', 'review.refineScopeItem2'],
          promptLabelKey: 'review.extraFixLabel',
          promptPlaceholderKey: 'review.extraFixPlaceholder',
          confirmTextKey: 'review.confirmPolish',
        }}
      />
    </div>
  )
}
