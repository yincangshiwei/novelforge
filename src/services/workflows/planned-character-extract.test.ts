// @vitest-environment jsdom
import { it, expect, vi, beforeEach } from 'vitest'
import { useProjectStore } from '../../stores/project-store'
import { ipc } from '../ipc-client'
import { extractPlannedCharacters } from './planned-character-extract'
import type { ChapterBlueprint } from './directory-workflow'
import type { StepCallbacks, WorkflowContext } from '../../stores/workflow-store'
const mock = vi.hoisted(() => ({ llm: vi.fn() }))
vi.mock('../ipc-client', () => ({ ipc: { invoke: vi.fn() } }))
vi.mock('./commands/base-command', () => ({ BaseWorkflowCommand: class { callLLM = mock.llm } }))
const callbacks = { log: vi.fn() } as unknown as StepCallbacks
const context = { cancelled: false, data: {} } as WorkflowContext
const bp = { chapterNumber: 1, title: '相遇', characters: ['林晓', '顾舟'], purpose: '寻找入口', keyEvents: '顾舟引导林晓找到入口' } as ChapterBlueprint
beforeEach(() => {
  mock.llm.mockReset()
  vi.mocked(ipc.invoke).mockReset()
  context.cancelled = false
  useProjectStore.setState({ currentProject: { id: 'test', novelConfig: { genre: '奇幻' } } as never })
  vi.mocked(ipc.invoke).mockImplementation(async (...args) => {
    if (args[0] === 'db:character-get-all') return [{ name: '林晓', aliases: '[]' }] as never
    return { success: true, created: 1 } as never
  })
})
it('仅登记蓝图具名且有作用的新人物，不保存未来动态状态或重复人物', async () => {
  mock.llm.mockResolvedValue(JSON.stringify([
    { name: '林晓', tier: 1, notes: '已有主角' },
    { name: '顾舟', role: 'supporting', tier: 2, notes: '第一章引路，关联后续入口支线', currentState: { location: '未来地点' } },
    { name: '顾舟', tier: 3, notes: '重复' },
    { name: '凭空人物', tier: 1, notes: '不在蓝图' },
  ]))
  await extractPlannedCharacters([bp], 'test', callbacks, context)
  const call = vi.mocked(ipc.invoke).mock.calls.find(c => c[0] === 'db:character-create-missing')
  expect(call?.[1]).toEqual([expect.objectContaining({ name: '顾舟', tier: 2, appearChapters: '[]' })])
  expect((call?.[1] as Array<Record<string, unknown>>)[0].currentState).toBeUndefined()
})
it('全部人物已存在时不额外调用模型', async () => {
  await extractPlannedCharacters([{ ...bp, characters: ['林晓'] }], 'test', callbacks, context)
  expect(mock.llm).not.toHaveBeenCalled()
})
it('空结果正常结束，不创建空档案', async () => {
  mock.llm.mockResolvedValue('[]')
  await extractPlannedCharacters([bp], 'test', callbacks, context)
  expect(vi.mocked(ipc.invoke).mock.calls.some(c => c[0] === 'db:character-create-missing')).toBe(false)
})
it('取消后停止，不写角色库', async () => {
  context.cancelled = true
  await expect(extractPlannedCharacters([bp], 'test', callbacks, context)).rejects.toThrow('cancelled')
  expect(mock.llm).not.toHaveBeenCalled()
})
