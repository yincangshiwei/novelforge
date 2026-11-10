// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BaseWorkflowCommand } from './base-command'
import { renderLog } from '../../render-logger'
import type { StepCallbacks, WorkflowContext } from '../../../stores/workflow-store'

const h = vi.hoisted(() => ({ generateStream: vi.fn(), cancelGeneration: vi.fn() }))
vi.mock('../../ipc-client', () => ({ ipc: { invoke: vi.fn().mockResolvedValue({ success: true }) } }))
vi.mock('../../render-logger', () => ({ renderLog: vi.fn() }))
vi.mock('../../../stores/llm-store', () => ({
  useLLMStore: { getState: () => ({
    defaultModelId: 'm1', models: [], getModelForPurpose: () => 'm1',
    generateStream: h.generateStream, cancelGeneration: h.cancelGeneration,
  }) },
}))

class Probe extends BaseWorkflowCommand {
  async execute(): Promise<string> { return '' }
  run(context: WorkflowContext, callbacks: StepCallbacks): Promise<string> {
    return this.callLLM('prompt', 'system', callbacks, undefined, context)
  }
}
const callbacks = (): StepCallbacks => ({ log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() })

beforeEach(() => {
  vi.clearAllMocks()
  h.cancelGeneration.mockResolvedValue(undefined)
})
afterEach(() => vi.useRealTimers())

describe('callLLM cancellation', () => {
  it('快速失败仍有同一个请求ID关联任务、模型和日志', async () => {
    h.generateStream.mockImplementationOnce(async (_messages, cb) => { cb.onError('network failure'); return 'unused' })
    await expect(new Probe().run({ runId: 'run-1', stepId: 'step-1', data: {}, cancelled: false }, callbacks())).rejects.toThrow('network failure')
    const options = h.generateStream.mock.calls[0][3]
    expect(options.trace).toMatchObject({ runId: 'run-1', stepId: 'step-1' })
    expect(h.generateStream.mock.calls[0][2]).toBe('m1')
    expect(renderLog).toHaveBeenCalledWith('info', 'LLM', expect.stringContaining(`requestId=${options.requestId}`))
    expect(renderLog).toHaveBeenCalledWith('error', 'LLM', expect.stringContaining(`requestId=${options.requestId}`))
  })
  it('pre-aborted signal never starts a request', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(new Probe().run({ data: {}, cancelled: false, signal: controller.signal }, callbacks())).rejects.toThrow()
    expect(h.generateStream).not.toHaveBeenCalled()
  })

  it('abort settles before requestId and cancels the late request exactly once', async () => {
    let finish!: (id: string) => void
    h.generateStream.mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve }))
    const controller = new AbortController()
    const cb = callbacks()
    const result = new Probe().run({ data: {}, cancelled: false, signal: controller.signal }, cb)
    const rejected = expect(result).rejects.toThrow()
    controller.abort()
    await rejected
    expect(h.generateStream.mock.calls[0][3]).not.toHaveProperty('signal')
    const streamCallbacks = h.generateStream.mock.calls[0][1]
    streamCallbacks.onChunk('late')
    streamCallbacks.onDone('late')
    streamCallbacks.onError('late error')
    expect(cb.appendText).not.toHaveBeenCalled()
    expect(cb.setProgress).not.toHaveBeenCalledWith(90)
    finish('late-id')
    await Promise.resolve()
    expect(h.cancelGeneration).toHaveBeenCalledExactlyOnceWith('late-id')
  })

  it('registered request rejects immediately while cancellation IPC receipt is pending', async () => {
    h.generateStream.mockResolvedValueOnce('registered-id')
    h.cancelGeneration.mockImplementationOnce(() => new Promise<void>(() => {}))
    const controller = new AbortController()
    const cb = callbacks()
    const result = new Probe().run({ data: {}, cancelled: false, signal: controller.signal }, cb)
    const rejected = expect(result).rejects.toThrow()
    await Promise.resolve()
    controller.abort()
    await rejected
    expect(h.cancelGeneration).toHaveBeenCalledExactlyOnceWith('registered-id')
    const streamCallbacks = h.generateStream.mock.calls[0][1]
    streamCallbacks.onChunk('late')
    streamCallbacks.onDone('late', { promptTokens: 1, completionTokens: 1, totalTokens: 2 })
    expect(cb.appendText).not.toHaveBeenCalled()
    expect(cb.log).not.toHaveBeenCalled()
    expect(cb.setProgress).not.toHaveBeenCalledWith(90)
  })

  it('late requestId still triggers cancellation without waiting for its IPC receipt', async () => {
    let finish!: (id: string) => void
    h.generateStream.mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve }))
    h.cancelGeneration.mockImplementationOnce(() => new Promise<void>(() => {}))
    const controller = new AbortController()
    const result = new Probe().run({ data: {}, cancelled: false, signal: controller.signal }, callbacks())
    const rejected = expect(result).rejects.toThrow()
    controller.abort()
    await rejected
    finish('late-pending-receipt')
    await Promise.resolve()
    expect(h.cancelGeneration).toHaveBeenCalledExactlyOnceWith('late-pending-receipt')
  })

  it('rejected cancellation IPC receipt is handled and never revives the request', async () => {
    h.generateStream.mockResolvedValueOnce('rejected-receipt')
    h.cancelGeneration.mockRejectedValueOnce(new Error('IPC closed'))
    const controller = new AbortController()
    const result = new Probe().run({ data: {}, cancelled: false, signal: controller.signal }, callbacks())
    const rejected = expect(result).rejects.toThrow()
    await Promise.resolve()
    controller.abort()
    await rejected
    expect(h.cancelGeneration).toHaveBeenCalledExactlyOnceWith('rejected-receipt')
  })

  it('legacy cancelled flag settles even when requestId never arrives', async () => {
    vi.useFakeTimers()
    h.generateStream.mockImplementationOnce(() => new Promise<string>(() => {}))
    const context = { data: {}, cancelled: false }
    const result = new Probe().run(context, callbacks())
    const rejected = expect(result).rejects.toThrow()
    context.cancelled = true
    await vi.advanceTimersByTimeAsync(200)
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })
})
