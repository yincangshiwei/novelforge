import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runPostProcessPipeline, settleWorkflowStream, withRetry } from './workflow-utils'
import type { StepCallbacks, WorkflowContext } from '../../stores/workflow-store'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../ipc-client', () => ({ ipc: { invoke } }))

const callbacks: StepCallbacks = { appendText: vi.fn(), log: vi.fn(), setProgress: vi.fn() }
const makeContext = () => {
  const controller = new AbortController()
  const context: WorkflowContext = { data: {}, cancelled: false, signal: controller.signal }
  return { controller, context }
}

describe('后处理取消边界', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'db:post-process-get-latest-run') return { id: 1 }
      if (channel === 'db:post-process-get-steps') return []
      if (channel === 'db:post-process-create-run') return { success: true, id: 1 }
      return { success: true }
    })
  })

  it('AbortError 不触发重试', async () => {
    const error = Object.assign(new Error('cancelled'), { name: 'AbortError' })
    const fn = vi.fn().mockRejectedValue(error)
    await expect(withRetry(fn, 2, 'step', callbacks)).rejects.toBe(error)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('只有 cancelled 标记时同样停止重试', async () => {
    const context: WorkflowContext = { data: {}, cancelled: false }
    const fn = vi.fn(async () => { context.cancelled = true; throw new Error('transport failed') })
    await expect(withRetry(fn, 2, 'step', callbacks, context)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('stream 返回的 promise 拒绝也能 settle', async () => {
    const error = new Error('start rejected')
    await expect(settleWorkflowStream(() => Promise.reject(error), vi.fn(), vi.fn())).rejects.toBe(error)
  })

  it('取消在 requestId 返回前发生：立即 settle，迟到 id 只取消对应请求', async () => {
    const { controller, context } = makeContext()
    let returnId!: (id: string) => void
    let streamCallbacks!: Parameters<Parameters<typeof settleWorkflowStream<string>>[0]>[0]
    const cancel = vi.fn().mockResolvedValue(undefined)
    const chunk = vi.fn()
    const result = settleWorkflowStream<string>(cb => {
      streamCallbacks = cb
      return new Promise<string>(resolve => { returnId = resolve })
    }, chunk, cancel, context)
    const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejection
    streamCallbacks.onChunk('late')
    streamCallbacks.onDone('late')
    returnId('owned-request')
    await Promise.resolve()
    expect(chunk).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledExactlyOnceWith('owned-request')
  })

  it('正常完成后清理 abort listener 并忽略迟到回调', async () => {
    const { controller, context } = makeContext()
    const cancel = vi.fn().mockResolvedValue(undefined)
    const chunk = vi.fn()
    let streamCallbacks!: Parameters<Parameters<typeof settleWorkflowStream<string>>[0]>[0]
    const result = settleWorkflowStream<string>(async cb => {
      streamCallbacks = cb
      cb.onDone('done')
      return 'request'
    }, chunk, cancel, context)
    await expect(result).resolves.toBe('done')
    controller.abort()
    streamCallbacks.onChunk('late')
    streamCallbacks.onError('late')
    expect(chunk).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
  })

  it('已提交步骤写入保留，但取消后不写结果状态也不启动后续批次', async () => {
    const { controller, context } = makeContext()
    const next = vi.fn()
    const first = vi.fn(async (_cb: StepCallbacks, received?: WorkflowContext) => {
      expect(received).toBe(context)
      await invoke('submitted-write')
      controller.abort()
    })
    await expect(runPostProcessPipeline('/project', 'archive', 'archive', [
      { key: 'first', label: 'first', critical: false, executor: first },
      { key: 'next', label: 'next', critical: false, dependsOn: ['first'], executor: next },
    ], callbacks, { context })).rejects.toMatchObject({ name: 'AbortError' })
    expect(first).toHaveBeenCalledTimes(1)
    expect(next).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith('submitted-write')
    expect(invoke.mock.calls.some(([channel]) => channel === 'db:post-process-mark-step-ok' || channel === 'db:post-process-mark-step-failed')).toBe(false)
  })

  it('预取消不创建后处理 run', async () => {
    const { controller, context } = makeContext()
    controller.abort()
    await expect(runPostProcessPipeline('/project', 'archive', 'archive', [], callbacks, { context })).rejects.toMatchObject({ name: 'AbortError' })
    expect(invoke).not.toHaveBeenCalled()
  })
})
