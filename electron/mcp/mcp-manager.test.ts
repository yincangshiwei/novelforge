/**
 * MCP connectById 安全加固测试（L4 S10）
 *
 * 背景：`mcp:connect` 原先接受渲染层传来的**完整配置**，直通
 * `spawn(command, args, { env: { ...process.env, ...env } })` —— 渲染层（或一次主帧 XSS）
 * 传 `{ command: 'cmd.exe', args: ['/c', '…'] }` 即可**任意代码执行**，绕过整个 fs 白名单。
 *
 * 现在只接受 id，command/args/env 一律取主进程自己从配置文件读到的值。
 * 本测试全部走 mock，**不会真的 spawn 任何进程**。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mcpManager, type MCPServerConfig } from './mcp-manager'

const h = vi.hoisted(() => ({ signal: undefined as AbortSignal | undefined, spawn: vi.fn() }))
vi.mock('child_process', () => ({ spawn: h.spawn }))
vi.mock('../services/agent-operation-journal', () => ({
  currentOperationSignal: () => h.signal,
  checkOperationCancellation: () => {
    if (h.signal?.aborted) throw Object.assign(new Error('操作已取消'), { name: 'AbortError' })
  },
}))
vi.mock('../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

function fixtureRuntime() {
  const process = Object.assign(new EventEmitter(), {
    stdin: { write: vi.fn(), writable: true, destroyed: false },
    stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
  })
  return {
    config: FILE_CONFIG, status: 'connected', tools: [], resources: [], buffer: '', nextRequestId: 1,
    process,
    pendingRequests: new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timerId: ReturnType<typeof setTimeout> }>(),
  }
}
type Runtime = ReturnType<typeof fixtureRuntime>
const internal = mcpManager as unknown as {
  sendRequest: (runtime: Runtime, method: string, params?: unknown, signal?: AbortSignal) => Promise<unknown>
  connectStdio: (runtime: Runtime) => Promise<void>
  servers: Map<string, Runtime>
}

describe('MCP 取消、超时和进程终止', () => {
  it('发送后取消保留 unknown，取消通知仅发送一次且不重试', async () => {
    const runtime = fixtureRuntime()
    internal.servers.set(FILE_CONFIG.id, runtime)
    const controller = new AbortController()
    h.signal = controller.signal
    const promise = mcpManager.callTool(FILE_CONFIG.id, 'fixture', {})
    const assertion = expect(promise).rejects.toMatchObject({ name: 'AbortError', remoteOutcome: 'unknown', message: expect.stringContaining('remote outcome unknown') })
    controller.abort()
    await assertion
    expect(runtime.process.stdin.write).toHaveBeenCalledTimes(2)
    expect(JSON.parse(runtime.process.stdin.write.mock.calls[1][0])).toMatchObject({ method: 'notifications/cancelled', params: { requestId: 1 } })
    expect(runtime.pendingRequests.size).toBe(0)
  })

  it('发送前取消不产生请求', async () => {
    const runtime = fixtureRuntime()
    const controller = new AbortController()
    controller.abort()
    await expect(internal.sendRequest(runtime, 'tools/call', {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(runtime.process.stdin.write).not.toHaveBeenCalled()
  })

  it('超时发送取消并抛 unknown，清除计时器而不重试', async () => {
    vi.useFakeTimers()
    const runtime = fixtureRuntime()
    internal.servers.set(FILE_CONFIG.id, runtime)
    const promise = mcpManager.callTool(FILE_CONFIG.id, 'fixture', {})
    const assertion = expect(promise).rejects.toMatchObject({ remoteOutcome: 'unknown' })
    await vi.advanceTimersByTimeAsync(10000)
    await assertion
    expect(runtime.process.stdin.write).toHaveBeenCalledTimes(2)
    expect(JSON.parse(runtime.process.stdin.write.mock.calls[1][0]).method).toBe('notifications/cancelled')
    expect(runtime.pendingRequests.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  for (const event of ['exit', 'error'] as const) {
    it(`${event} 立即清理 pending 计时器并抛 unknown`, async () => {
      vi.useFakeTimers()
      const runtime = fixtureRuntime()
      h.spawn.mockReturnValue(runtime.process)
      await internal.connectStdio(runtime)
      const promise = internal.sendRequest(runtime, 'tools/call', {})
      const assertion = expect(promise).rejects.toMatchObject({ remoteOutcome: 'unknown' })
      runtime.process.emit(event, event === 'error' ? new Error('fixture failure') : 1)
      await assertion
      expect(runtime.pendingRequests.size).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    })
  }
})

/** 假装配置文件里已登记的服务（注意 command 是文件里的值，不是调用方给的） */
const FILE_CONFIG: MCPServerConfig = {
  id: 'fs-server',
  name: 'fs-server',
  transport: 'stdio',
  command: 'node',
  args: ['server.js'],
}

afterEach(() => {
  h.signal = undefined
  internal.servers.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('connectById（L4 S10：渲染层不能指定要 spawn 的命令）', () => {
  it('空 / 纯空白 id → 拒绝，且不进入 connect（不 spawn）', async () => {
    const connectSpy = vi.spyOn(mcpManager, 'connect')
    await expect(mcpManager.connectById('')).rejects.toThrow()
    await expect(mcpManager.connectById('   ')).rejects.toThrow()
    // @ts-expect-error 运行时防御：非字符串（JS 调用方 / 绕过类型）也必须拒绝
    await expect(mcpManager.connectById(undefined)).rejects.toThrow()
    expect(connectSpy).not.toHaveBeenCalled()
  })

  it('未登记的 id（攻击者自造）→ 拒绝，且绝不调用 connect', async () => {
    vi.spyOn(mcpManager, 'loadConfig').mockResolvedValue([FILE_CONFIG])
    const connectSpy = vi.spyOn(mcpManager, 'connect').mockResolvedValue()

    await expect(mcpManager.connectById('attacker-server')).rejects.toThrow(/未登记/)
    expect(connectSpy).not.toHaveBeenCalled()
  })

  it('已登记 id → 用**配置文件里**的 command/args 调用 connect（调用方无从插手）', async () => {
    vi.spyOn(mcpManager, 'loadConfig').mockResolvedValue([FILE_CONFIG])
    const connectSpy = vi.spyOn(mcpManager, 'connect').mockResolvedValue()

    await mcpManager.connectById('fs-server')

    expect(connectSpy).toHaveBeenCalledTimes(1)
    // 关键断言：传给 connect 的整份配置来自文件，而不是任何调用方入参
    expect(connectSpy.mock.calls[0][0]).toEqual(FILE_CONFIG)
    expect(connectSpy.mock.calls[0][0].command).toBe('node')
  })
})
