import { describe, expect, it, vi } from 'vitest'
import type { WorkflowContext } from '../../../stores/workflow-store'

const h = vi.hoisted(() => ({ callLLM: vi.fn(), save: vi.fn(), parse: vi.fn(), invoke: vi.fn() }))
vi.mock('../../ipc-client', () => ({ ipc: { invoke: h.invoke } }))
vi.mock('./base-command', () => ({ BaseWorkflowCommand: class { callLLM = h.callLLM } }))
vi.mock('../../../stores/project-store', () => ({ useProjectStore: { getState: () => ({
  currentProject: { path: '/novel', novelConfig: { totalChapters: 3 } }, refreshFileTree: vi.fn(),
}) } }))
vi.mock('../../../stores/llm-store', () => ({ useLLMStore: { getState: () => ({ models: [] }) } }))
vi.mock('../../prompt-templates', () => ({ getPromptTemplate: () => ({ systemRole: 'author' }) }))
vi.mock('../../prompts/prompt-builder', () => ({ DirectoryPromptBuilder: class {
  withNovelArchitecture() { return this }
  withNumberOfChapters() { return this }
  withGlobalGuidance() { return this }
  withGenre() { return this }
  withPacingGuidance() { return this }
  withChapterRange() { return this }
  withExistingChapters() { return this }
  withChapterList() { return this }
  withN() { return this }
  withM() { return this }
  build() { return 'prompt' }
} }))
vi.mock('../directory-workflow', () => ({ parseTextBlueprints: h.parse, parseTextBlueprintsFromParsed: h.parse, saveAllBlueprints: h.save }))
vi.mock('../workflow-utils', () => ({ stripThinkingTags: (s: string) => s, extractAndRepairJSON: () => ({}) }))
import { GenerateDirectoryCommand } from './directory.command'
const callbacks = { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() }

describe('蓝图取消与已保存批次恢复', () => {
  it('旧任务断点丢失仍可读取数据库继续，仅补缺章', async () => {
    h.save.mockReset()
    h.callLLM.mockReset().mockResolvedValue('next')
    h.parse.mockReset().mockReturnValue([{ chapterNumber: 2, title: 'b' }])
    h.invoke.mockResolvedValueOnce([{ chapterNumber: 1, title: 'a', keyEvents: '' }, { chapterNumber: 3, title: 'c', keyEvents: '' }])
    const context: WorkflowContext = { data: { architecture: 'world' }, cancelled: false }
    const result = await new GenerateDirectoryCommand({ mode: 'full', continueSaved: true }).execute({ step: {}, context, callbacks })
    expect(h.invoke).toHaveBeenCalledWith('db:blueprint-get-all')
    expect(h.parse.mock.calls.at(-1)?.[1]).toBe(2)
    expect(h.save).toHaveBeenCalledWith([{ chapterNumber: 2, title: 'b' }])
    expect(result.map(b => b.chapterNumber).sort()).toEqual([1, 2, 3])
  })
  it('取消后返回的蓝图不得入库，LLM收到工作流context', async () => {
    h.save.mockReset()
    const context: WorkflowContext = { data: { architecture: 'world' }, cancelled: false }
    h.callLLM.mockImplementationOnce(async () => { context.cancelled = true; return 'late' })
    await expect(new GenerateDirectoryCommand({ mode: 'full' }).execute({ step: {}, context, callbacks })).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.callLLM.mock.calls.at(-1)?.[4]).toBe(context)
    expect(h.save).not.toHaveBeenCalled()
    expect(context.data.newBlueprints).toEqual([])
  })
  it('恢复跳过已保存章节并在新批次提交后保存checkpoint', async () => {
    h.save.mockReset()
    h.callLLM.mockResolvedValueOnce('next')
    h.parse.mockReturnValueOnce([{ chapterNumber: 2, title: 'b' }, { chapterNumber: 3, title: 'c' }])
    const checkpoint = vi.fn(async () => {})
    const context: WorkflowContext = { data: { architecture: 'world', newBlueprints: [{ chapterNumber: 1, title: 'a', keyEvents: '' }] }, cancelled: false, checkpoint }
    const result = await new GenerateDirectoryCommand({ mode: 'full' }).execute({ step: {}, context, callbacks })
    expect(h.parse.mock.calls.at(-1)?.[1]).toBe(2)
    expect(h.save).toHaveBeenCalledWith([{ chapterNumber: 2, title: 'b' }, { chapterNumber: 3, title: 'c' }])
    expect(result.map(b => b.chapterNumber)).toEqual([1, 2, 3])
    expect(checkpoint).toHaveBeenCalledOnce()
  })
  it('恢复有缺口时不覆盖已保存章节，持续无新增结果会失败而非无限请求', async () => {
    h.save.mockReset()
    h.callLLM.mockReset().mockResolvedValue('duplicate')
    h.parse.mockReset().mockReturnValue([{ chapterNumber: 3, title: '不得覆盖' }])
    const context: WorkflowContext = { data: { architecture: 'world', newBlueprints: [
      { chapterNumber: 1, title: 'a', keyEvents: '' }, { chapterNumber: 3, title: '原始', keyEvents: '' },
    ] }, cancelled: false }
    await expect(new GenerateDirectoryCommand({ mode: 'full' }).execute({ step: {}, context, callbacks })).rejects.toThrow()
    expect(h.callLLM).toHaveBeenCalledTimes(5)
    expect(h.save).not.toHaveBeenCalled()
    expect((context.data.newBlueprints as { title: string }[])[1].title).toBe('原始')
  })
})
