import { buildAgentTool } from '../tool-registry'
import { createToolIpc } from '../tool-ipc'
import { ToolExecutionInterrupted } from '../tool-execution'
import { useProjectStore } from '../../../stores/project-store'
import { useCharacterStore } from '../../../stores/character-store'
import { matchCharacterName, normalizeCharacterTier, normalizeCharacterRole } from '../../character-normalize'
import { createMissingCharacters } from '../../planned-characters'
import { globalEventBus } from '../../../shared/event-bus'

export const manageCharacterTool = buildAgentTool({
  name: 'manage_character',
  description: '创建或调整数据库角色卡，不是写角色文件。先 read_characters 查重。role 是身份，tier=1主要角色、2关键配角、3次要角色。只提交要改的字段，保留其他档案；成功回执才表示已保存。',
  userFacingName: '创建或调整角色卡',
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', description: '创建或更新', enum: ['create', 'update'] },
      name: { type: 'string', description: '角色姓名；更新支持已有别名，不用于改名' },
      fields_json: { type: 'string', description: 'JSON 对象，仅提交要改的字段：role、tier(1/2/3)、gender、age、appearance、personality、background、abilities、motivation、relationships、arc、notes。notes 写剧情作用和分级依据。' },
    },
    required: ['action', 'name', 'fields_json'],
  },
  requiresConfirmation: true,
  isReadOnly: false,
  reconcile: async (args, context) => {
    const toolIpc = createToolIpc(context)
    const project = useProjectStore.getState().currentProject
    if (!project || context.signal.aborted || (context.scope && context.scope !== project.path)) return undefined
    try {
      if (args.action !== 'create' && args.action !== 'update') return undefined
      const fields = JSON.parse(String(args.fields_json)) as Record<string, unknown>
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return undefined
      const existing = await toolIpc.invoke('db:character-get-all')
      const target = matchCharacterName(existing, String(args.name ?? '').trim())
      if (!target || context.signal.aborted || useProjectStore.getState().currentProject?.path !== project.path) return undefined
      const expected = { ...fields }
      if (args.action === 'create') {
        expected.role = normalizeCharacterRole(String(fields.role ?? 'supporting'))
        expected.tier = normalizeCharacterTier(fields.tier, expected.role)
      } else if (fields.tier !== undefined) expected.tier = Number(fields.tier)
      if (Object.entries(expected).some(([key, value]) => (target as unknown as Record<string, unknown>)[key] !== value)) return undefined
      return { success: true, executionState: 'committed', content: '已只读核验角色卡实际字段与原操作一致；不重复保存。', persistence: { target: `character:${target.name}`, verified: true, projectPath: project.path } }
    } catch { return undefined }
  },
  execute: async (args, context) => {
    const toolIpc = createToolIpc(context)
    if (context?.signal.aborted) return { success: false, executionState: 'not_committed', content: '', error: '操作已取消' }
    let executionState: 'not_committed' | 'unknown' | 'committed' = 'not_committed'
    const project = useProjectStore.getState().currentProject
    if (!project) return { success: false, content: '', error: '请先打开小说项目' }
    if (useCharacterStore.getState().dirty) return { success: false, content: '', error: '角色卡有未保存编辑，请先保存，避免覆盖' }
    try {
      if (args.action !== 'create' && args.action !== 'update') throw new Error('Invalid action')
      const name = String(args.name ?? '').trim()
      if (!name) throw new Error('角色名不能为空')
      const fields = JSON.parse(String(args.fields_json)) as Record<string, unknown>
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('fields_json 必须是对象')
      const allowed = new Set(['role', 'tier', 'gender', 'age', 'appearance', 'personality', 'background', 'abilities', 'motivation', 'relationships', 'arc', 'notes'])
      for (const [key, value] of Object.entries(fields)) {
        if (!allowed.has(key)) throw new Error(`不支持的字段：${key}`)
        if (key === 'tier') {
          if (![1, 2, 3].includes(Number(value))) throw new Error('tier 必须为1、2或3')
          fields.tier = Number(value)
        } else if (typeof value !== 'string') throw new Error(`${key} 必须是字符串`)
      }
      if (fields.role !== undefined && !['protagonist', 'antagonist', 'supporting', 'minor'].includes(String(fields.role))) throw new Error('Invalid role')
      const existing = await toolIpc.invoke('db:character-get-all')
      const target = matchCharacterName(existing, name)
      if (context?.signal.aborted || useProjectStore.getState().currentProject?.path !== project.path || (context?.scope && context.scope !== project.path)) throw new Error('Operation cancelled or project changed')
      if (args.action === 'create') {
        if (target) throw new Error(`角色 ${target.name} 已存在，请使用 update`)
        const role = normalizeCharacterRole(String(fields.role ?? 'supporting'))
        executionState = 'unknown'
        const created = await createMissingCharacters([{ ...fields, name, role, tier: normalizeCharacterTier(fields.tier, role) }], project.id, context)
        if (!created) { executionState = 'not_committed'; throw new Error('角色已存在，未覆盖') }
        executionState = 'committed'
      } else {
        if (!target) throw new Error('角色不存在，请使用 create')
        executionState = 'unknown'
        const result = await toolIpc.invoke('db:character-upsert', { ...target, ...fields })
        if (!result.success) { executionState = 'not_committed'; throw new Error(result.error || '角色保存失败') }
        executionState = 'committed'
        if (!context?.signal.aborted && useProjectStore.getState().currentProject?.path === project.path) {
          try { globalEventBus.emit('REFRESH_RESOURCE', { resources: ['characterCards'] }) }
          catch (error) { console.warn('[manage_character] 已提交，角色界面刷新失败', error) }
        }
      }
      return { success: true, executionState: 'committed', content: `已保存角色卡：${target?.name ?? name}；未提交字段保持不变。` }
    } catch (error) {
      if (error instanceof ToolExecutionInterrupted) throw error
      return { success: false, executionState, content: '', error: String(error) }
    }
  },
})
