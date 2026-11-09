/**
 * read_characters — 读取角色卡档案
 */
import { t } from '../../../shared/locale'
import { buildAgentTool } from '../tool-registry'
import { createToolIpc } from '../tool-ipc'
import { normalizeCharacterTier, matchCharacterName } from '../../character-normalize'
import { useProjectStore } from '../../../stores/project-store'


export const readCharactersTool = buildAgentTool({
  name: 'read_characters',
  description: t('tool.readCharsDesc'),
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {
      character_name: {
        type: 'string',
        description: t('tool.readCharsName'),
      },
    },
  },
  requiresConfirmation: false,
  execute: async (args, context) => {
    const toolIpc = createToolIpc(context)
    if (context?.signal.aborted) return { success: false, executionState: 'not_committed', content: '', error: '操作已取消' }
    const project = useProjectStore.getState().currentProject
    if (!project) {
      return { success: false, content: '', error: t('error.noProject') }
    }

    const charName = args.character_name as string | undefined

    try {
      const charsResult = await toolIpc.invoke('db:character-get-all')
      const chars = (Array.isArray(charsResult) ? charsResult : []) as unknown as Array<Record<string, unknown>>
      if (!chars || chars.length === 0) {
        return { success: true, content: t('tool.readCharsEmpty') }
      }

      if (charName) {
        // 查找指定角色——精确匹配优先（P1 修复：此前子串 includes 取第一个命中，
        // 查询「林」可能命中「林峰」而非主角「林晓」，返回卡片与意图不符且无提示）
        const query = charName.trim()
        const exact = matchCharacterName(chars as Array<{ name: unknown }>, query)
        const target = exact ?? chars.find((c) =>
          String(c.name).toLowerCase().includes(query.toLowerCase())
        )
        if (!target) {
          const available = chars.map((c) => String(c.name)).join('、')
          return { success: false, content: '', error: t('tool.readCharsNotFound').replace('{name}', charName).replace('{available}', available) }
        }

        const formatted = Object.entries(target)
          .filter(([k, v]) => v && k !== 'id')
          .map(([k, v]) => `**${k}**: ${typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v)}`)
          .join('\n')
        return { success: true, content: t('tool.readCharsCard').replace('{name}', String(target.name)).replace('{formatted}', formatted) }
      }

      const labels = [t('graph.tierCore'), t('graph.tierImportant'), t('graph.tierMinor')]
      const list = [1, 2, 3].map(tier => {
        const group = chars.filter(c => normalizeCharacterTier(c.tier, c.role) === tier)
        const rows = group.map(c => `- ${String(c.name)} (role=${String(c.role)}, tier=${tier}, status=${String(c.status || 'active')})`)
        return `${labels[tier - 1]}：${group.length}\n${rows.join('\n')}`
      }).join('\n\n')
      return { success: true, content: t('tool.readCharsList').replace('{count}', String(chars.length)).replace('{list}', list) }
    } catch (error) {
      return { success: false, content: '', error: t('tool.readCharsFailed').replace('{error}', String(error)) }
    }
  },
})
