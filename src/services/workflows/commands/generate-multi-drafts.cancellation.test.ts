// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GenerateMultiDraftsCommand } from './generate-multi-drafts.command'
import type { CommandExecuteParams } from './base-command'

const h = vi.hoisted(() => ({ generate: vi.fn(), recordCall: vi.fn() }))
vi.mock('../../../stores/llm-store', () => ({ useLLMStore: { getState: () => ({
  getModelForPurpose: () => 'm1', models: [{ id: 'm1' }], generate: h.generate,
}) } }))
vi.mock('../../../stores/usage-store', () => ({ useUsageStore: { getState: () => ({ recordCall: h.recordCall }) } }))
vi.mock('../../prompt-templates', () => ({ getPromptTemplate: () => ({}) }))
vi.mock('../../prompts/prompt-builder', () => ({ ChapterPromptBuilder: class {
  withArchitecture() { return this }
  withChapterInfo() { return this }
  withGlobalGuidance() { return this }
  withUserGuidance() { return this }
  build() { return 'prompt' }
  getSystemRole() { return 'system' }
} }))
vi.mock('../../render-logger', () => ({ renderLog: vi.fn() }))

const draftParams = { chapterNumber: 1, chapterTitle: 'title', blueprintContext: '', voiceContext: '', globalGuidance: '' }
const params = (signal?: AbortSignal): CommandExecuteParams => ({
  step: {}, context: { data: {}, cancelled: false, signal },
  callbacks: { log: vi.fn(), appendText: vi.fn(), setProgress: vi.fn() },
})
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers() })

describe('multi-draft cancellation', () => {
  it('cancelled candidate result neither enters scoring nor becomes success', async () => {
    const controller = new AbortController()
    class Probe extends GenerateMultiDraftsCommand {
      protected async callLLM(): Promise<string> { controller.abort(); return 'late' }
    }
    await expect(new Probe(draftParams).execute(params(controller.signal))).rejects.toThrow()
    expect(h.generate).not.toHaveBeenCalled()
  })

  it('cancel during scoring does not score the next candidate or record usage', async () => {
    const controller = new AbortController()
    class Probe extends GenerateMultiDraftsCommand {
      protected async callLLM(): Promise<string> { return 'draft' }
    }
    h.generate.mockImplementationOnce(async (_messages, _modelId, options) => {
      expect(options.signal.aborted).toBe(false)
      controller.abort()
      expect(options.signal.aborted).toBe(true)
      return { success: true, content: '{"overallScore":8}' }
    })
    await expect(new Probe(draftParams).execute(params(controller.signal))).rejects.toThrow()
    expect(h.generate).toHaveBeenCalledTimes(1)
    expect(h.recordCall).not.toHaveBeenCalled()
  })

  it('legacy cancelled flag aborts an active scoring request', async () => {
    vi.useFakeTimers()
    class Probe extends GenerateMultiDraftsCommand {
      protected async callLLM(): Promise<string> { return 'draft' }
    }
    const executeParams = params()
    h.generate.mockImplementationOnce((_messages, _modelId, options) => new Promise(resolve => {
      options.signal.addEventListener('abort', () => resolve({ success: false, content: '' }), { once: true })
    }))
    const result = new Probe(draftParams).execute(executeParams)
    const rejected = expect(result).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(0)
    executeParams.context.cancelled = true
    await vi.advanceTimersByTimeAsync(200)
    await rejected
    expect(h.generate).toHaveBeenCalledTimes(1)
    expect(h.recordCall).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
