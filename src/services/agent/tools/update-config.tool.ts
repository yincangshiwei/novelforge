/**
 * update_config — 更新小说配置
 */
import { t } from '../../../shared/locale'
import { buildAgentTool } from '../tool-registry'
import { createToolIpc } from '../tool-ipc'
import { useProjectStore } from '../../../stores/project-store'

export const updateConfigTool = buildAgentTool({
  name: 'update_config',
  description: t('tool.updateConfigDesc'),
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {
      field: {
        type: 'string',
        description: t('tool.updateConfigField'),
        // ⚠️ 字段体系与主进程白名单（project-controller.ts）及 read_project_state 输出对齐：
        //    补 plotStructure/narrativePOV（此前主进程可写但工具 enum 缺失，行为与声明不符）
        enum: ['genre', 'subGenre', 'targetAudience', 'totalChapters', 'wordsPerChapter',
               'coreOutline', 'worldSetting', 'goldenFinger', 'protagonistProfile',
               'globalGuidance', 'writingStyle', 'referenceWorks',
               'plotStructure', 'narrativePOV'],
      },
      value: {
        type: 'string',
        description: t('tool.updateConfigValue'),
      },
    },
    required: ['field', 'value'],
  },
  requiresConfirmation: true,
  isReadOnly: false,
  reconcile: async (args, context) => {
    const toolIpc = createToolIpc(context)
    const project = useProjectStore.getState().currentProject
    if (!project || (context.scope && context.scope !== project.path) || context.signal.aborted) return undefined
    const core = await toolIpc.invoke('db:project-core-get')
    if (!core || context.signal.aborted || useProjectStore.getState().currentProject?.path !== project.path) return undefined
    const field = String(args.field)
    const key = field === 'narrativePOV' ? 'narrativePov' : field
    const expected = ['totalChapters', 'wordsPerChapter'].includes(field) ? Number(args.value) : args.value
    if ((core as unknown as Record<string, unknown>)[key] !== expected) return undefined
    useProjectStore.getState().updateNovelConfig({ [field]: expected })
    return { success: true, executionState: 'committed', content: `已读取实际配置，${field} 与原操作值一致；不重复写入。`,
      persistence: { target: `config:${field}`, verified: true, projectPath: project.path } }
  },
  execute: async (args, context) => {
    const toolIpc = createToolIpc(context)
    if (context?.signal.aborted) return { success: false, executionState: 'not_committed', content: '', error: '操作已取消，未提交' }
    const field = args.field as string
    const value = args.value as string

    if (!field || value === undefined) {
      return { success: false, content: '', error: t('error.missingFieldValue') }
    }

    // ⚠️ execute 内再次校验 field ∈ enum（LLM 可能传任意字符串——此前任意字段也会写入并返回成功）
    const ALLOWED_FIELDS = new Set([
      'genre', 'subGenre', 'targetAudience', 'totalChapters', 'wordsPerChapter',
      'coreOutline', 'worldSetting', 'goldenFinger', 'protagonistProfile',
      'globalGuidance', 'writingStyle', 'referenceWorks', 'plotStructure', 'narrativePOV',
    ])
    if (!ALLOWED_FIELDS.has(field)) {
      return { success: false, content: '', error: t('tool.updateConfigInvalidField').replace('{field}', field) }
    }

    // 数字字段归一化：LLM 传 "12" 字符串会写入字符串类型，下游数值解析 NaN（P1 修复）
    const NUMERIC_FIELDS = new Set(['totalChapters', 'wordsPerChapter'])
    let finalValue: string | number = value
    if (NUMERIC_FIELDS.has(field)) {
      const n = Number(value)
      if (value.trim() === '' || isNaN(n)) {
        return { success: false, content: '', error: t('tool.updateConfigInvalidNumber').replace('{field}', field).replace('{value}', value) }
      }
      finalValue = n
    }

    const project = useProjectStore.getState().currentProject
    if (!project) {
      return { success: false, content: '', error: t('error.noProject') }
    }

    // 构造更新数据 —— ⚠️ **只发被改的那一个字段**。
    //
    // 真机 bug 修复（2026-09-13）：原实现是 `{ ...project.novelConfig, [field]: finalValue }`，
    // 即把**渲染层缓存里的整份配置**一起写回。而主进程 `project:update-config` 是逐字段
    // 判 `!== undefined` 合并 —— 收到整份就等于「所有列都写」。缓存不会因为上一次工具调用
    // 而刷新，于是**连续改多个字段时，后一次会把前一次改过的字段写回旧值**。
    // 实测症状：连续改 genre → subGenre → writingStyle 后回读，writingStyle 是新的，
    // 而 genre/subGenre 退回旧值，Agent 只得反复重提，最终撞上工具调用次数上限。
    // 只发单字段后，主进程的逐字段合并语义才真正成立（也是该 handler 的原始设计意图）。
    const updateData = {
      path: project.path,
      novelConfig: { [field]: finalValue },
    }

    if (context?.signal.aborted || useProjectStore.getState().currentProject?.path !== project.path || (context?.scope && context.scope !== project.path)) return { success: false, executionState: 'not_committed', content: '', error: '操作已取消或项目已切换，未提交' }
    const result = await toolIpc.invoke('project:update-config', project.id, updateData)
    if (!result.success) {
      return { success: false, content: '', error: result.error ?? t('tool.updateConfigFailed') }
    }

    const persistedValue = result.persistedConfig?.[field as keyof NonNullable<typeof result.persistedConfig>]
    if (result.projectPath !== project.path || persistedValue !== finalValue) {
      return { success: false, executionState: 'unknown', content: '', error: '配置写入未通过回读核验，不能确认保存成功，请重新读取实际状态。' }
    }
    if (!context?.signal.aborted && useProjectStore.getState().currentProject?.path === project.path) {
      try { useProjectStore.getState().updateNovelConfig({ [field]: persistedValue }) }
      catch (error) { console.warn('[update_config] 已提交，配置界面刷新失败', error) }
    }

    return {
      success: true,
      executionState: 'committed',
      persistence: { target: `config:${field}`, verified: true, projectPath: result.projectPath, revision: result.revision },
      content: t('tool.configUpdated')
        .replace('{field}', field)
        .replace('{value}', typeof value === 'string' && value.length > 50 ? value.slice(0, 50) + '…' : String(value)),
    }
  },
})
