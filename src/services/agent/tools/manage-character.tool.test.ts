// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ipc } from '../../ipc-client'
import { useProjectStore } from '../../../stores/project-store'
import { useCharacterStore, EMPTY_CARD } from '../../../stores/character-store'
import { manageCharacterTool } from './manage-character.tool'
import { readCharactersTool } from './read-characters.tool'
import { readProjectStateTool } from './read-project-state.tool'

vi.mock('../../ipc-client', () => ({ ipc: { invoke: vi.fn() } }))
const invoke = vi.mocked(ipc.invoke)
const oldCard = { ...EMPTY_CARD, name: '阶段对手', role: 'antagonist', tier: 3, appearance: '旧外貌', aliases: '["城主"]' }

beforeEach(() => {
  invoke.mockReset()
  useCharacterStore.setState({ dirty: false })
  useProjectStore.setState({ currentProject: { id: 'test', name: '测试', novelConfig: { globalGuidance: '保持人物辨识度' } } as never })
  invoke.mockImplementation(async (...args) => {
    const channel = args[0]
    if (channel === 'db:character-get-all') return [oldCard] as never
    if (channel === 'db:project-core-get') return { globalGuidance: '保持人物辨识度' } as never
    if (channel === 'db:character-create-missing') return { success: true, created: 1 } as never
    return { success: true } as never
  })
})

describe('Agent 人物与创作要求接口', () => {
  it('修改别名匹配人物的等级，不清空其他档案', async () => {
    const result = await manageCharacterTool.execute({ action: 'update', name: '城主', fields_json: '{"tier":2}' })
    expect(result.success).toBe(true)
    const call = invoke.mock.calls.find(c => c[0] === 'db:character-upsert')
    expect(call?.[1]).toMatchObject({ name: '阶段对手', tier: 2, appearance: '旧外貌', aliases: '["城主"]' })
  })
  it('新增已有别名被拒，不覆盖原角色', async () => {
    const result = await manageCharacterTool.execute({ action: 'create', name: '城主', fields_json: '{"tier":1}' })
    expect(result.success).toBe(false)
    expect(invoke.mock.calls.some(c => c[0] === 'db:character-create-missing')).toBe(false)
  })
  it('新建主要配角正确保存独立等级', async () => {
    const result = await manageCharacterTool.execute({ action: 'create', name: '长期伙伴', fields_json: '{"role":"supporting","tier":1,"notes":"长期参与主线"}' })
    expect(result.success).toBe(true)
    const call = invoke.mock.calls.find(c => c[0] === 'db:character-create-missing')
    expect(call?.[1]).toEqual([expect.objectContaining({ name: '长期伙伴', role: 'supporting', tier: 1, appearChapters: '[]' })])
  })
  it('非法字段、等级和未保存编辑阻止写入', async () => {
    expect((await manageCharacterTool.execute({ action: 'update', name: '阶段对手', fields_json: '{"tier":9}' })).success).toBe(false)
    expect((await manageCharacterTool.execute({ action: 'update', name: '阶段对手', fields_json: '{"name":"改名"}' })).success).toBe(false)
    useCharacterStore.setState({ dirty: true })
    expect((await manageCharacterTool.execute({ action: 'update', name: '阶段对手', fields_json: '{"tier":1}' })).success).toBe(false)
    expect(invoke.mock.calls.some(c => c[0] === 'db:character-upsert')).toBe(false)
  })
  it('角色列表按等级显示，详情支持别名', async () => {
    const list = await readCharactersTool.execute({})
    expect(list.content).toContain('次要角色：1')
    expect(list.content).toContain('tier=3')
    expect((await readCharactersTool.execute({ character_name: '城主' })).content).toContain('旧外貌')
  })
  it('项目配置读取包含完整全局写作要求', async () => {
    const result = await readProjectStateTool.execute({ include_config: true, include_summary: false })
    expect(result.content).toContain('globalGuidance')
    expect(result.content).toContain('保持人物辨识度')
  })
})
