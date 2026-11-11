import { describe, expect, it, vi } from 'vitest'
import type { WorkflowContext } from '../../../stores/workflow-store'

const h = vi.hoisted(() => ({ callLLM: vi.fn(), save: vi.fn(), parse: vi.fn(), invoke: vi.fn(), n: vi.fn(), m: vi.fn(), totalChapters: 3 }))
vi.mock('../../ipc-client', () => ({ ipc: { invoke: h.invoke } }))
vi.mock('./base-command', () => ({ BaseWorkflowCommand: class { callLLM = h.callLLM } }))
vi.mock('../../../stores/project-store', () => ({ useProjectStore: { getState: () => ({
  currentProject: { path: '/novel', novelConfig: { totalChapters: h.totalChapters } }, refreshFileTree: vi.fn(),
}) } }))
vi.mock('../../../stores/llm-store', () => ({ useLLMStore: { getState: () => ({ models: [], getModelForPurpose: () => 'blueprint' }) } }))
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
  withN(value: number) { h.n(value); return this }
  withM(value: number) { h.m(value); return this }
  build() { return 'prompt' }
} }))
vi.mock('../directory-workflow', () => ({ parseTextBlueprints: h.parse, parseTextBlueprintsFromParsed: h.parse, saveAllBlueprints: h.save }))
vi.mock('../workflow-utils', () => ({ stripThinkingTags: (s: string) => s, extractAndRepairJSON: () => ({}) }))
import { GenerateDirectoryCommand } from './directory.command'
const callbacks = { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() }

describe('蓝图取消与已保存批次恢复', () => {
  it('全书1632章但任务限定1–368，最后一批止于368且不会调用369章', async () => {
    h.totalChapters = 1632
    h.callLLM.mockReset().mockResolvedValue('batch')
    h.save.mockReset()
    h.parse.mockReset().mockImplementation((_text: string, start: number, end: number) =>
      Array.from({ length: Math.min(12, end - start + 1) }, (_, i) => ({ chapterNumber: start + i, title: 'chapter', keyEvents: '' })))
    h.n.mockClear()
    h.m.mockClear()
    callbacks.log.mockClear()
    try {
      const context: WorkflowContext = { data: { architecture: 'world' }, cancelled: false }
      const result = await new GenerateDirectoryCommand({ mode: 'append', startChapter: 1, count: 368 }).execute({ step: {}, context, callbacks })
      expect(context.data.directoryStart).toBe(1)
      expect(context.data.directoryEnd).toBe(368)
      expect(callbacks.log).toHaveBeenCalledWith(expect.stringContaining('1–368'))
      expect(result).toHaveLength(368)
      expect(h.n).toHaveBeenLastCalledWith(361)
      expect(h.m).toHaveBeenLastCalledWith(368)
      expect(h.callLLM).toHaveBeenCalledTimes(31)
      expect(h.save.mock.calls.flatMap(call => call[0]).every(b => b.chapterNumber <= 368)).toBe(true)
    } finally { h.totalChapters = 3 }
  })
  it('长篇首批提示词明确限定范围，流失败保留章节与原始原因', async () => {
    h.totalChapters = 1632
    h.n.mockClear()
    h.m.mockClear()
    h.save.mockReset()
    h.callLLM.mockReset().mockRejectedValueOnce(new Error('stream unknown'))
    try {
      const context: WorkflowContext = { data: { architecture: 'world' }, cancelled: false }
      await expect(new GenerateDirectoryCommand({ mode: 'full' }).execute({ step: {}, context, callbacks })).rejects.toThrow('stream unknown')
      expect(h.n).toHaveBeenCalledWith(1)
      expect(h.m).toHaveBeenCalledWith(12)
      expect(h.save).not.toHaveBeenCalled()
    } finally { h.totalChapters = 3 }
  })
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
