import { t } from '../../shared/locale'
import { useEditorStore } from '../../stores/editor-store'
import { aiFlavorAudit } from './audits'
import { loadAuditWhitelist } from './audit-context'
import { mergeAiFlavorReview } from './ai-flavor-review'

export async function auditRefinement(content: string, baseDraftId?: number, baseVersion?: number) {
  const auditedAt = Date.now()
  try {
    if (!content.trim()) throw new Error(t('error.noDraft'))
    const audit = aiFlavorAudit(content, await loadAuditWhitelist())
    return {
      ...mergeAiFlavorReview({ items: [] }, audit, content),
      scope: 'revision_candidate', baseDraftId, baseVersion, auditedAt,
      checked: true,
    }
  } catch (error) {
    return {
      items: [{ category: t('audit.aiFlavorCategory'), severity: 'warning', description: String(error), quote: '' }],
      summary: t('audit.refinementUnchecked'),
      scope: 'revision_candidate', baseDraftId, baseVersion, auditedAt,
      checked: false,
    }
  }
}

export function openRefinementAudit(report: string, revisionId: number, chapterNumber?: number) {
  useEditorStore.getState().openFile({
    id: `revision-audit-${revisionId}`,
    name: t('audit.refinementReport').replace('{id}', String(revisionId)),
    type: 'review-report',
    content: report,
    chapterNumber,
    reportPath: `vela://revision/${revisionId}/audit`,
  })
}
