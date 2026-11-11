import { t } from '../../shared/locale'
import { parseReport, type ReviewIssue } from '../../components/editor/review-report-parser'
import { normalizeReviewIssue } from '../review-actions'
import type { AuditResult } from './audits'

export interface ParsedReview {
  items?: Array<Record<string, string>>
  summary?: string
  rawResponse?: string
}

export function mergeAiFlavorReview(parsed: ParsedReview, audit: AuditResult, draft: string) {
  const paragraphs: Array<{ start: number; end: number }> = []
  const separators = [...draft.matchAll(/\n\s*\n+/g)]
  let offset = 0
  for (const separator of [...separators, { index: draft.length, 0: '' }]) {
    const end = separator.index
    const raw = draft.slice(offset, end)
    const trimmed = raw.trim()
    if (trimmed) {
      const start = offset + raw.indexOf(trimmed)
      paragraphs.push({ start, end: start + trimmed.length })
    }
    offset = end + separator[0].length
  }
  const legacy = parsed.rawResponse ? parseReport(parsed.rawResponse) : undefined
  const items: Array<Record<string, string>> = parsed.rawResponse
    ? (legacy?.issues ?? []).map(item => ({ ...item, quote: item.quote ?? '' }))
    : [...(parsed.items ?? [])]
  if (parsed.rawResponse && legacy?.parseFailed) {
    items.push({ category: t('review.comprehensiveCheck'), severity: 'warning', quote: '', description: parsed.rawResponse })
  }
  for (const issue of audit.issues) {
    const spans = [...(issue.position ?? '').matchAll(/第(\d+)段/g)]
      .map(m => paragraphs[Number(m[1]) - 1]).filter(Boolean)
    const quote = spans.length
      ? draft.slice(Math.min(...spans.map(span => span.start)), Math.max(...spans.map(span => span.end)))
      : ''
    items.push({
      category: t('audit.aiFlavorCategory'),
      severity: issue.severity === 'error' ? 'error' : 'warning',
      quote,
      ...(spans.length ? {
        quoteStart: String(Math.min(...spans.map(span => span.start))),
        quoteEnd: String(Math.max(...spans.map(span => span.end))),
      } : {}),
      description: [issue.position, issue.message].filter(Boolean).join('：'),
    })
  }
  if (audit.passed) {
    items.push({ category: t('audit.aiFlavorCategory'), severity: 'pass', quote: '', description: t('audit.aiFlavorRulePass') })
  }
  return {
    items: items.map(item => normalizeReviewIssue(draft, item as unknown as ReviewIssue)),
    summary: [parsed.summary || legacy?.summary, audit.summary].filter(Boolean).join('\n'),
    ...(parsed.rawResponse ? { rawResponse: parsed.rawResponse } : {}),
    aiFlavorAudit: audit,
  }
}
