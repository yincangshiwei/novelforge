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

export class ReviewLocationError extends Error {
  constructor(reason: 'missing' | 'notFound' | 'repeated', issue: ReviewIssue) {
    const key = reason === 'missing' ? 'review.noExactQuote'
      : reason === 'notFound' ? 'review.quoteNotFound' : 'review.quoteRepeated'
    super(`${issue.category}：${issue.description}\n${t(key)}`)
  }
}

function normalizeLineBreaks(text: string) {
  let value = ''
  const starts: number[] = []
  const ends: number[] = []
  const tokens = /(?:\r\n|\r|\n)(?:[ \t]*(?:\r\n|\r|\n))*|[^\r\n]/g
  for (const match of text.matchAll(tokens)) {
    value += /^[\r\n]/.test(match[0]) ? '\n' : match[0]
    starts.push(match.index)
    ends.push(match.index + match[0].length)
  }
  return { value, starts, ends }
}

function locateReviewIssue(content: string, issue: ReviewIssue) {
  const quote = typeof issue.quote === 'string' ? issue.quote.trim() : ''
  if (!quote) throw new ReviewLocationError('missing', issue)
  const offsetStart = Number(issue.quoteStart)
  const offsetEnd = Number(issue.quoteEnd)
  if (issue.quoteStart !== undefined && issue.quoteEnd !== undefined
    && Number.isSafeInteger(offsetStart) && Number.isSafeInteger(offsetEnd)
    && offsetStart >= 0 && offsetEnd > offsetStart && offsetEnd <= content.length
    && content.slice(offsetStart, offsetEnd) === quote) {
    return { start: offsetStart, end: offsetEnd, quote, issue, issues: [issue] }
  }
  const exactStart = content.indexOf(quote)
  if (exactStart >= 0) {
    if (content.indexOf(quote, exactStart + 1) >= 0) throw new ReviewLocationError('repeated', issue)
    return { start: exactStart, end: exactStart + quote.length, quote, issue, issues: [issue] }
  }
  const wrappers = [['**', '**'], ['`', '`'], ['“', '”'], ['「', '」'], ['"', '"'], ['‘', '’']]
  const wrapper = wrappers.find(([open, close]) => quote.startsWith(open) && quote.endsWith(close) && quote.length > open.length + close.length)
  const unwrapped = wrapper ? quote.slice(wrapper[0].length, -wrapper[1].length) : quote
  const candidates = [...new Set([quote, unwrapped].map(value =>
    normalizeLineBreaks(value.replace(/<br\s*\/?\s*>/gi, '\n').replace(/\\r\\n|\\n/g, '\n')).value,
  ))]
  const normalized = normalizeLineBreaks(content)
  const matches = new Map<string, { start: number; end: number }>()
  for (const candidate of candidates) {
    if (!candidate) continue
    let from = 0
    let index: number
    while ((index = normalized.value.indexOf(candidate, from)) >= 0) {
      const start = normalized.starts[index]
      const end = normalized.ends[index + candidate.length - 1]
      matches.set(`${start}:${end}`, { start, end })
      if (matches.size > 1) throw new ReviewLocationError('repeated', issue)
      from = index + 1
    }
  }
  const match = [...matches.values()][0]
  if (!match) throw new ReviewLocationError('notFound', issue)
  return { ...match, quote: content.slice(match.start, match.end), issue, issues: [issue] }
}

export function normalizeReviewIssue(content: string, issue: ReviewIssue): ReviewIssue {
  if (issue.severity === 'pass') return issue
  try {
    const span = locateReviewIssue(content, issue)
    return { ...issue, quote: span.quote, quoteStart: String(span.start), quoteEnd: String(span.end) }
  } catch (error) {
    if (!(error instanceof ReviewLocationError)) throw error
    return issue
  }
}

export function locateReviewEdits(content: string, issues: ReviewIssue[]) {
  const spans = issues.map(issue => locateReviewIssue(content, issue)).sort((a, b) => a.start - b.start)
  const merged: typeof spans = []
  for (const span of spans) {
    const previous = merged[merged.length - 1]
    if (previous && span.start < previous.end) {
      previous.end = Math.max(previous.end, span.end)
      previous.quote = content.slice(previous.start, previous.end)
      previous.issues.push(...span.issues)
    } else merged.push(span)
  }
  return merged
}

export function applyReviewEdits(content: string, edits: Array<{ start: number; end: number; replacement: string }>): string {
  let result = content
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end)
  }
  return result
}
