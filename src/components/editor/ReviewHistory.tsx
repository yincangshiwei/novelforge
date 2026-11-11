import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReviewMeta } from '../../../electron/repositories/review-repository'
import { useTranslation } from '../../hooks/useTranslation'
import { ipc } from '../../services/ipc-client'
import { VELA } from '../../services/vela-protocol'
import { globalEventBus } from '../../shared/event-bus'
import { useEditorStore } from '../../stores/editor-store'
import { useProjectStore } from '../../stores/project-store'
import { Button } from '../ui/Button'
import { confirm } from '../ui/Confirm'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/Dialog'
import { toast } from '../ui/Toast'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  draftId: number
  version: number
  chapterNumber: number
  filePath: string
  onCountChange: (count: number) => void
}

export default function ReviewHistory({ open, onOpenChange, draftId, version, chapterNumber, filePath, onCountChange }: Props) {
  const { t, locale } = useTranslation()
  const project = useProjectStore(s => s.currentProject)
  const [reviews, setReviews] = useState<ReviewMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const generation = useRef(0)
  const request = useRef(0)
  const label = (review: ReviewMeta) => t('editor.reviewLabel').replace('{version}', String(version)).replace('{index}', String(review.reviewIndex))

  const reload = useCallback(async () => {
    const token = ++request.current
    const context = generation.current
    setLoading(true)
    setError('')
    try {
      const entries = await ipc.invoke('db:review-list', draftId)
      if (token !== request.current || context !== generation.current || useProjectStore.getState().currentProject !== project) return
      setReviews([...entries].sort((a, b) => b.reviewIndex - a.reviewIndex || b.id - a.id))
      onCountChange(entries.length)
    } catch (e) {
      if (token === request.current && context === generation.current) setError(String(e))
    } finally {
      if (token === request.current && context === generation.current) setLoading(false)
    }
  }, [draftId, project, onCountChange])

  useEffect(() => {
    const generationRef = generation
    const requestRef = request
    const context = ++generationRef.current
    pending.current = false
    queueMicrotask(() => {
      if (context !== generationRef.current) return
      setReviews([])
      setBusy(false)
      setLoading(false)
      if (open) void reload()
    })
    const off = globalEventBus.on('REFRESH_RESOURCE', ({ resources }) => {
      if (open && (resources.includes('reviews') || resources.includes('all'))) void reload()
    })
    return () => { generationRef.current++; requestRef.current++; off() }
  }, [open, draftId, filePath, project, reload])

  const run = async (review: ReviewMeta, remove: boolean) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    const context = generation.current
    const isCurrent = () => context === generation.current && useProjectStore.getState().currentProject === project
    try {
      if (remove) {
        const ok = await confirm(t('editor.reviewDeleteConfirm').replace('{label}', label(review)), {
          title: t('editor.reviewDelete'), confirmText: t('editor.reviewDelete'), danger: true,
        })
        if (!ok || !isCurrent()) return
        const result = await ipc.invoke('db:review-delete', review.id)
        if (!isCurrent()) return
        if (!result.success) throw new Error(result.error)
        const editor = useEditorStore.getState()
        for (const tab of editor.tabs) {
          if (tab.type === 'review-report' && tab.reportPath === `${VELA.REVIEW}${review.id}`) editor.closeTab(tab.id)
        }
        setReviews(entries => entries.filter(entry => entry.id !== review.id))
        globalEventBus.emit('REFRESH_RESOURCE', { resources: ['reviews'] })
        toast.success(t('editor.reviewDeleted'))
      } else {
        const report = await ipc.invoke('db:review-get-full', review.id)
        if (!isCurrent()) return
        if (!report?.content || report.baseDraftId !== draftId) throw new Error(t('editor.reviewMissing'))
        onOpenChange(false)
        useEditorStore.getState().openFile({
          id: `review-report-${chapterNumber}-${review.id}`,
          name: label(review), type: 'review-report', content: report.content,
          filePath, reportPath: `${VELA.REVIEW}${review.id}`, reviewReport: report.content,
          chapterNumber, chapterDir: `${VELA.DRAFT}ch${chapterNumber}`,
        })
      }
    } catch (e) {
      if (isCurrent()) toast.error(t('editor.reviewError').replace('{error}', String(e)))
    } finally {
      if (isCurrent()) { pending.current = false; setBusy(false) }
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="p-5">
        <DialogHeader>
          <DialogTitle>{t('editor.reviewHistory')}</DialogTitle>
          <DialogDescription>{t('editor.reviewHistoryHint')}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between mt-4 text-xs text-[var(--color-text-secondary)]">
          <span>{t('editor.reviewReportBtn').replace('{n}', String(reviews.length))}</span>
          <Button variant="ghost" disabled={busy || loading} onClick={() => void reload()}>{t('editor.reviewRefresh')}</Button>
        </div>
        <div className="max-h-[55vh] overflow-y-auto mt-2 space-y-2" aria-busy={loading || busy}>
          {error && <p role="alert" className="text-xs text-[var(--color-error)]">{t('editor.reviewError').replace('{error}', error)}</p>}
          {!loading && !error && reviews.length === 0 && <p className="py-6 text-center text-xs text-[var(--color-text-secondary)]">{t('editor.reviewEmpty')}</p>}
          {reviews.map(review => (
            <div key={review.id} className="flex items-center justify-between gap-3 p-3 rounded-md border border-[var(--color-border)]">
              <div className="min-w-0">
                <p className="text-xs font-medium text-[var(--color-text)]">{label(review)}</p>
                <time className="text-xs text-[var(--color-text-secondary)]" dateTime={new Date(review.createdAt).toISOString()}>{new Date(review.createdAt).toLocaleString(locale)}</time>
              </div>
              <div className="flex gap-1 shrink-0">
                <Button variant="outline" disabled={busy || loading} onClick={() => void run(review, false)} aria-label={`${t('editor.reviewView')} ${label(review)}`}>{t('editor.reviewView')}</Button>
                <Button variant="ghost" className="text-[var(--color-error)]" disabled={busy || loading} onClick={() => void run(review, true)} aria-label={`${t('editor.reviewDelete')} ${label(review)}`}>{t('editor.reviewDelete')}</Button>
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
