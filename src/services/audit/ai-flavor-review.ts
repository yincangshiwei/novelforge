import { t } from '../../shared/locale'
import { parseReport } from '../../components/editor/review-report-parser'
import type { AuditResult } from './audits'

export interface ParsedReview {
  items?: Array<Record<string, string>>
  summary?: string
  rawResponse?: string
}

export function mergeAiFlavorReview(parsed: ParsedReview, audit: AuditResult, draft: string) {
  const paragraphs = draft.split(/\n\s*\n+/).map(p => p.trim()).filter(Boolean)
  const legacy = parsed.rawResponse ? parseReport(parsed.rawResponse) : undefined
  const items: Array<Record<string, string>> = parsed.rawResponse
    ? (legacy?.issues ?? []).map(item => ({ ...item, quote: item.quote ?? '' }))
    : [...(parsed.items ?? [])]
  if (parsed.rawResponse && legacy?.parseFailed) {
    items.push({ category: t('review.comprehensiveCheck'), severity: 'warning', quote: '', description: parsed.rawResponse })
  }
  for (const issue of audit.issues) {
    const indices = [...(issue.position ?? '').matchAll(/第(\d+)段/g)].map(m => Number(m[1]) - 1)
    items.push({
      category: t('audit.aiFlavorCategory'),
      severity: issue.severity === 'error' ? 'error' : 'warning',
      quote: indices.map(i => paragraphs[i]).filter(Boolean).join('\n\n'),
      description: [issue.position, issue.message].filter(Boolean).join('：'),
    })
  }
  if (audit.passed) {
    items.push({ category: t('audit.aiFlavorCategory'), severity: 'pass', quote: '', description: t('audit.aiFlavorRulePass') })
  }
  return {
    items,
    summary: [parsed.summary || legacy?.summary, audit.summary].filter(Boolean).join('\n'),
    ...(parsed.rawResponse ? { rawResponse: parsed.rawResponse } : {}),
    aiFlavorAudit: audit,
  }
}
