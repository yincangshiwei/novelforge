import { describe, it, expect, vi, afterEach } from 'vitest'
import { executeTool, restoreUnknownExecutions, ToolExecutionInterrupted } from './tool-execution'
import { buildAgentTool, type ToolExecutionContext, type ToolResult } from './tool-registry'
import { createToolIpc } from './tool-ipc'
import { canonicalJson } from '../../shared/canonical-json'
import type { AgentOperationRequest } from '../../shared/agent-operation-protocol'

const operationInvoke = vi.hoisted(() => vi.fn())
vi.mock('../ipc-client', () => ({ ipc: { invoke: operationInvoke } }))

const context = (): ToolExecutionContext => ({ signal: new AbortController().signal, turnId: crypto.randomUUID(), step: 1, callId: 'call', operationId: 'op' })
const tool = (execute: () => Promise<ToolResult>) => buildAgentTool({ name: 'p2_write', description: '', source: 'builtin', inputSchema: { type: 'object', properties: {} }, requiresConfirmation: false, isReadOnly: false, execute })
afterEach(() => vi.useRealTimers())

describe('工具中断与未知写入', () => {
  it('父task等待审批时暂停超时，恢复后只消耗剩余执行预算', async () => {
    vi.useFakeTimers()
    let resume!: () => void
    let finish!: (result: ToolResult) => void
    const task = buildAgentTool({ name: 'task', description: '', source: 'builtin',
      inputSchema: { type: 'object', properties: {} }, requiresConfirmation: false, isReadOnly: true,
      execute: async (_args, ctx) => {
        resume = ctx!.pauseExecutionTimeout!()
        return new Promise<ToolResult>(resolve => { finish = resolve })
      },
    })
    const running = executeTool(task, {}, context(), 100)
    await vi.advanceTimersByTimeAsync(10000)
    resume()
    await vi.advanceTimersByTimeAsync(99)
    finish({ success: true, content: 'done' })
    expect((await running).success).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['运行期中断', '归档恢复'] as const)('%s 核对使用新IPC及取消身份，不重复写入', async mode => {
    const c = context()
    c.scope = crypto.randomUUID()
    c.conversationId = crypto.randomUUID()
    c.toolName = 'p2_write'
    const fingerprints = new Map<string, string>()
    const cancelledCalls = new Set<string>(mode === '归档恢复' ? ['old-call'] : [])
    const requests: AgentOperationRequest[] = []
    operationInvoke.mockReset().mockImplementation(async (channel: string, request: AgentOperationRequest | string) => {
      if (channel === 'agent:operation-cancel') { cancelledCalls.add(String(request)); return { success: true } }
      const op = request as AgentOperationRequest
      requests.push(op)
      if (!op.toolName || cancelledCalls.has(op.callId)) return { state: 'not_committed', error: '无效或已取消身份' }
      const fingerprint = canonicalJson({ channel: op.channel, args: op.args })
      if (fingerprints.has(op.operationId) && fingerprints.get(op.operationId) !== fingerprint) return { state: 'not_committed', error: '操作ID参数冲突' }
      fingerprints.set(op.operationId, fingerprint)
      if (op.channel === 'fs:write-file') return { state: 'unknown' }
      return { state: 'committed', value: { success: true, content: '已保存正文' } }
    })
    const execute = vi.fn(async (args: Record<string, unknown>, ctx?: ToolExecutionContext): Promise<ToolResult> => {
      await createToolIpc(ctx).invoke('fs:write-file', String(args.path), '已保存正文')
      return { success: true, content: '写入完成' }
    })
    const write = buildAgentTool({ name: 'p2_write', description: '', source: 'builtin', inputSchema: { type: 'object', properties: {} },
      requiresConfirmation: false, isReadOnly: false, execute,
      reconcile: async (args, ctx) => {
        const result = await createToolIpc(ctx).invoke('fs:read-file', String(args.path))
        return result.success ? { success: true, executionState: 'committed', content: result.content ?? '' } : undefined
      },
    })
    if (mode === '归档恢复') restoreUnknownExecutions([{ id: 'old-call', turnId: 'old-turn', toolName: write.name,
      arguments: { path: 'a' }, status: 'failed', receipt: { turnId: 'old-turn', callId: 'old-call', step: 1, toolName: write.name, target: 'a', outcome: 'unknown', verified: false } }], c.scope, c.conversationId)
    else await expect(executeTool(write, { path: 'a' }, c, 100)).rejects.toMatchObject({ unknown: true })
    expect((await executeTool(write, { path: 'a' }, c, 100)).content).toContain('未重复执行')
    const read = requests.find(op => op.channel === 'fs:read-file')!
    expect(read.toolName).toBe(write.name)
    expect(read.conversationId).toBe(c.conversationId)
    expect(read.callId).not.toBe(mode === '归档恢复' ? 'old-call' : c.callId)
    expect(read.operationId).not.toBe(`${c.operationId}:ipc:0`)
    expect(execute).toHaveBeenCalledTimes(mode === '归档恢复' ? 0 : 1)
  })

  it('确定未提交后新调用身份才重试，真实IPC取消墓碑不重复副作用', async () => {
    const first = context()
    first.scope = crypto.randomUUID()
    first.toolName = 'p2_write'
    const cancelled = new Set<string>()
    let writes = 0
    let effects = 0
    operationInvoke.mockReset().mockImplementation(async (channel: string, request: AgentOperationRequest | string) => {
      if (channel === 'agent:operation-cancel') { cancelled.add(String(request)); return { success: true } }
      const op = request as AgentOperationRequest
      if (cancelled.has(op.callId)) return { state: 'not_committed', error: '操作已取消' }
      if (op.channel === 'fs:read-file') return { state: 'committed', value: { success: true, content: '未提交' } }
      writes++
      if (writes === 1) return { state: 'unknown' }
      effects++
      return { state: 'committed', value: { success: true } }
    })
    const write = buildAgentTool({ name: 'p2_write', description: '', source: 'builtin', inputSchema: { type: 'object', properties: {} },
      isReadOnly: false, requiresConfirmation: false,
      execute: async (args, ctx) => {
        await createToolIpc(ctx).invoke('fs:write-file', String(args.path), '新正文')
        return { success: true, content: '已写入' }
      },
      reconcile: async (args, ctx) => {
        await createToolIpc(ctx).invoke('fs:read-file', String(args.path))
        return { success: false, executionState: 'not_committed', content: '确定未提交' }
      },
    })
    await expect(executeTool(write, { path: 'a' }, first, 100)).rejects.toMatchObject({ unknown: true })
    const retry = { ...first, signal: new AbortController().signal, callId: crypto.randomUUID(), operationId: crypto.randomUUID() }
    expect((await executeTool(write, { path: 'a' }, retry, 100)).success).toBe(true)
    expect(cancelled.has(first.callId)).toBe(true)
    expect(writes).toBe(2)
    expect(effects).toBe(1)
  })

  it('未知操作核对挂起也超时，不放行写入', async () => {
    vi.useFakeTimers()
    const c = context(); c.scope = crypto.randomUUID()
    const execute = vi.fn(async () => ({ success: true, content: '' })), write = tool(execute)
    restoreUnknownExecutions([{ id: 'old', toolName: write.name, arguments: { path: 'a' }, status: 'failed',
      receipt: { turnId: 't', callId: 'old', step: 1, toolName: write.name, target: 'a', outcome: 'unknown', verified: false } }], c.scope)
    write.reconcile = () => new Promise(() => {})
    const assertion = expect(executeTool(write, { path: 'a' }, c, 10)).rejects.toMatchObject({ unknown: true })
    await vi.advanceTimersByTimeAsync(10); await assertion
    expect(execute).not.toHaveBeenCalled()
  })
  it('恢复unknown回执不执行；核对普通失败仍不重试', async () => {
    const c = context(); c.scope = crypto.randomUUID()
    const execute = vi.fn(async () => ({ success: true, content: '' }))
    const write = tool(execute)
    restoreUnknownExecutions([{ id: 'old', toolName: write.name, arguments: { path: 'a' }, status: 'failed',
      receipt: { turnId: 'old-turn', callId: 'old', step: 1, toolName: write.name, target: 'a', outcome: 'unknown', verified: false } }], c.scope)
    expect(execute).not.toHaveBeenCalled()
    write.reconcile = vi.fn(async () => ({ success: false, content: '查询失败' }))
    await expect(executeTool(write, { path: 'a' }, c, 100)).rejects.toMatchObject({ unknown: true })
    expect(execute).not.toHaveBeenCalled()
    write.reconcile = vi.fn(async () => ({ success: true, content: '实际已提交' }))
    expect((await executeTool(write, { path: 'a' }, c, 100)).content).toContain('未重复执行')
    expect(execute).not.toHaveBeenCalled()
  })
  it('取消前不启动工具', async () => {
    const c = context()
    const abort = new AbortController(); abort.abort(); c.signal = abort.signal
    const execute = vi.fn(async () => ({ success: true, content: '' }))
    await expect(executeTool(tool(execute), {}, c, 100)).rejects.toMatchObject({ unknown: false })
    expect(execute).not.toHaveBeenCalled()
  })
  it('执行微任务前同步取消，不留下未知写入门禁', async () => {
    const c = context()
    const controller = new AbortController()
    c.signal = controller.signal
    const execute = vi.fn(async () => ({ success: true, content: 'ok' }))
    const write = tool(execute)
    const run = executeTool(write, { path: 'microtask' }, c, 100)
    controller.abort()
    await expect(run).rejects.toMatchObject({ unknown: false })
    expect(execute).not.toHaveBeenCalled()
    c.signal = new AbortController().signal
    expect((await executeTool(write, { path: 'microtask' }, c, 100)).success).toBe(true)
    expect(execute).toHaveBeenCalledOnce()
  })
  it('超时发出abort，晚到提交不重复副作用', async () => {
    vi.useFakeTimers()
    let complete!: (result: ToolResult) => void
    let signal: AbortSignal | undefined
    const write = tool(vi.fn(() => new Promise<ToolResult>(resolve => { complete = resolve })))
    const original = write.execute
    write.execute = (args, c) => { signal = c?.signal; return original(args, c) }
    const c = context()
    const run = executeTool(write, { path: 'a' }, c, 10)
    const assertion = expect(run).rejects.toMatchObject({ unknown: true })
    await vi.advanceTimersByTimeAsync(10)
    await assertion
    expect(signal?.aborted).toBe(true)
    await expect(executeTool(write, { path: 'a' }, c, 10)).rejects.toBeInstanceOf(ToolExecutionInterrupted)
    complete({ success: true, content: '已提交' })
    await Promise.resolve(); await Promise.resolve()
    expect((await executeTool(write, { path: 'a' }, c, 10)).success).toBe(true)
    expect(original).toHaveBeenCalledOnce()
  })
  it('核对确定未提交后才重新执行', async () => {
    vi.useFakeTimers()
    const execute = vi.fn<() => Promise<ToolResult>>().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue({ success: true, content: 'ok' })
    const write = tool(execute)
    const c = context()
    const assertion = expect(executeTool(write, {}, c, 10)).rejects.toMatchObject({ unknown: true })
    await vi.advanceTimersByTimeAsync(10); await assertion
    write.reconcile = vi.fn(async () => ({ success: false, executionState: 'not_committed' as const, content: '确定未提交' }))
    expect((await executeTool(write, {}, c, 10)).success).toBe(true)
    expect(write.reconcile).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledTimes(2)
  })
  it('同目标不同参数不得复用旧成功结果', async () => {
    vi.useFakeTimers()
    let complete!: (r: ToolResult) => void
    const execute = vi.fn<() => Promise<ToolResult>>().mockImplementationOnce(() => new Promise(r => { complete = r })).mockResolvedValue({ success: true, content: '新值' })
    const write = tool(execute), c = context()
    const assertion = expect(executeTool(write, { path: 'a', value: '旧' }, c, 10)).rejects.toMatchObject({ unknown: true })
    await vi.advanceTimersByTimeAsync(10); await assertion
    complete({ success: true, content: '旧值' }); await Promise.resolve(); await Promise.resolve()
    expect((await executeTool(write, { path: 'a', value: '新' }, c, 10)).content).toBe('新值')
    expect(execute).toHaveBeenCalledTimes(2)
  })
})
