import { t } from '../../../shared/locale'
import { useProjectStore } from '../../../stores/project-store'
import { aiFlavorAudit } from '../../audit/audits'
import { loadAuditWhitelist } from '../../audit/audit-context'
import { buildAgentTool } from '../tool-registry'
import { createToolIpc } from '../tool-ipc'

export const aiFlavorAuditTool = buildAgentTool({
  name: 'ai_flavor_audit',
  description: t('tool.aiFlavorAuditDesc'),
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {
      chapter_number: { type: 'number', description: t('tool.readDraftsChapter') },
      draft_id: { type: 'number', description: t('tool.aiFlavorDraftId') },
    },
    required: ['chapter_number'],
  },
  requiresConfirmation: false,
  isReadOnly: true,
  execute: async (args, context) => {
    const project = useProjectStore.getState().currentProject
    if (!project) return { success: false, content: '', error: t('error.noProject') }
    const interrupted = () => context?.signal.aborted
      || useProjectStore.getState().currentProject?.id !== project.id
    const chapter = Number(args.chapter_number)
    const draftId = args.draft_id === undefined ? undefined : Number(args.draft_id)
    if (!Number.isSafeInteger(chapter) || chapter <= 0 || (draftId !== undefined && (!Number.isSafeInteger(draftId) || draftId <= 0))) {
      return { success: false, content: '', error: t('tool.aiFlavorInvalidParams') }
    }
    if (interrupted()) return { success: false, content: '', error: t('tool.aiFlavorInterrupted') }
    const client = createToolIpc(context)
    try {
      const drafts = await client.invoke('db:draft-list', chapter)
      const valid = drafts.filter(d => d.status !== 'archived')
      const target = draftId === undefined
        ? [...valid].sort((a, b) => b.version - a.version)[0]
        : valid.find(d => d.id === draftId)
      if (!target) return { success: false, content: '', error: t('tool.draftNotFound') }
      const full = await client.invoke('db:draft-get-full', target.id)
      if (!full?.content?.trim()) return { success: false, content: '', error: t('error.noDraft') }
      const whitelist = await loadAuditWhitelist(client)
      if (interrupted()) return { success: false, content: '', error: t('tool.aiFlavorInterrupted') }
      return {
        success: true,
        content: JSON.stringify({
          chapterNumber: chapter, draftId: target.id, version: target.version,
          scope: 'rule_signals_only',
          ...aiFlavorAudit(full.content, whitelist),
        }, null, 2),
      }
    } catch (error) {
      return { success: false, content: '', error: String(error) }
    }
  },
})
