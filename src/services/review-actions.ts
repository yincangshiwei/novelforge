import { ipc } from './ipc-client'
import { parseReport, type ReviewIssue } from '../components/editor/review-report-parser'
import { t } from '../shared/locale'

export async function reviewContentHash(content: string): Promise<string> {
  if (!globalThis.crypto?.subtle?.digest) throw new Error(t('review.hashUnavailable'))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function reviewIssueKey(issue: ReviewIssue): string {
  return JSON.stringify([issue.category, issue.severity, issue.quote ?? '', issue.description])
}

export function getIgnoredReviewIssues(report: string, projectId: string): Set<string> {
  try {
    const stored = localStorage.getItem(`review-decisions:${projectId}:${report}`)
    return new Set(stored ? JSON.parse(stored) as string[] : [])
  } catch { return new Set() }
}

export function saveIgnoredReviewIssues(report: string, projectId: string, ignored: Set<string>): void {
  localStorage.setItem(`review-decisions:${projectId}:${report}`, JSON.stringify([...ignored]))
}

export async function isReviewCurrent(report: string, draftId: number, content: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(report) as { baseDraftId?: number; baseContentHash?: string; scope?: string }
    return parsed.scope !== 'revision_candidate' && parsed.baseDraftId === draftId
      && !!parsed.baseContentHash && parsed.baseContentHash === await reviewContentHash(content)
  } catch { return false }
}

export async function getCurrentDraftReview(draftId: number, content: string, projectId: string): Promise<string | null> {
  const reviews = await ipc.invoke('db:review-list', draftId)
  for (const review of [...reviews].sort((a, b) => b.reviewIndex - a.reviewIndex)) {
    const full = await ipc.invoke('db:review-get-full', review.id)
    if (!full || !await isReviewCurrent(full.content, draftId, content)) continue
    const ignored = getIgnoredReviewIssues(full.content, projectId)
    const items = parseReport(full.content).issues.filter(issue => issue.severity !== 'pass' && !ignored.has(reviewIssueKey(issue)))
    return items.length ? JSON.stringify({ ...JSON.parse(full.content), items, reviewSourceId: review.id }) : null
  }
  return null
}

export function locateReviewEdits(content: string, issues: ReviewIssue[]) {
  const spans = issues.map(issue => {
    const quote = issue.quote?.trim()
    if (!quote) throw new Error(t('review.noExactQuote'))
    const start = content.indexOf(quote)
    if (start < 0 || content.indexOf(quote, start + 1) >= 0) throw new Error(t('review.ambiguousQuote'))
    return { start, end: start + quote.length, quote, issue }
  }).sort((a, b) => a.start - b.start)
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].start < spans[i - 1].end) throw new Error(t('review.overlappingQuotes'))
  }
  return spans
}

export function applyReviewEdits(content: string, edits: Array<{ start: number; end: number; replacement: string }>): string {
  let result = content
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end)
  }
  return result
}
