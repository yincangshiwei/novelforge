// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ invoke: vi.fn(), events: new Map<string, (data: unknown) => void>(), unsub: vi.fn() }))
vi.mock('../services/ipc-client', () => ({ ipc: { invoke: h.invoke, on: (channel: string, cb: (data: unknown) => void) => { h.events.set(channel, cb); return h.unsub }, isElectron: true } }))
vi.mock('../services/render-logger', () => ({ renderLog: vi.fn() }))
import { useLLMStore } from './llm-store'

beforeEach(() => { vi.clearAllMocks(); h.events.clear(); useLLMStore.setState({ defaultModelId: 'm', activeRequests: new Map() }); h.invoke.mockResolvedValue({ started: true }) })
describe('LLM非流式取消', () => {
  it('预取消不发送生成请求', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await useLLMStore.getState().generate([], 'm', { signal: controller.signal })
    expect(result).toMatchObject({ success: false, content: '' })
    expect(h.invoke).not.toHaveBeenCalled()
  })

  it('取消立即结束，取消底层，并忽略晚到成功', async () => {
    let finish!: (value: unknown) => void
    h.invoke.mockImplementation((channel) => channel === 'llm:generate'
      ? new Promise((resolve) => { finish = resolve }) : Promise.resolve({ success: true }))
    const controller = new AbortController()
    const result = useLLMStore.getState().generate([], 'm', { requestId: 'cancel-me', signal: controller.signal })
    expect(h.invoke.mock.calls[0][1]).toMatchObject({ requestId: 'cancel-me' })
    expect(h.invoke.mock.calls[0][1]).not.toHaveProperty('signal')
    controller.abort()
    expect(await result).toMatchObject({ success: false, content: '' })
    expect(h.invoke).toHaveBeenCalledWith('llm:cancel', 'cancel-me')
    finish({ success: true, content: 'late' })
    await Promise.resolve()
    expect(await result).toMatchObject({ success: false, content: '' })
    expect(useLLMStore.getState().activeRequests.size).toBe(0)
  })

  it('取消后的晚到异常被消费且取消IPC失败不影响终态', async () => {
    let fail!: (reason: Error) => void
    h.invoke.mockImplementation((channel) => channel === 'llm:generate'
      ? new Promise((_resolve, reject) => { fail = reject }) : Promise.reject(new Error('cancel IPC failed')))
    const controller = new AbortController()
    const result = useLLMStore.getState().generate([], 'm', { signal: controller.signal })
    controller.abort()
    expect(await result).toMatchObject({ success: false })
    fail(new Error('late failure'))
    await Promise.resolve()
    expect(await result).toMatchObject({ success: false })
  })

  it('正常终态移除取消监听并保留结构化字段', async () => {
    const controller = new AbortController()
    const step = { text: '', toolCalls: [], terminalSeen: true }
    h.invoke.mockResolvedValueOnce({ success: true, content: '', step })
    expect(await useLLMStore.getState().generate([], 'm', { signal: controller.signal })).toMatchObject({ success: true, step })
    controller.abort()
    expect(h.invoke).toHaveBeenCalledTimes(1)
  })
})

describe('LLM结构化流', () => {
  it('原生字段透传并按requestId接收完整步骤，终态清理监听', async () => {
    const onDone = vi.fn()
    const tools = [{ name: 'read', description: '', parameters: { type: 'object' as const, properties: {} } }]
    const id = await useLLMStore.getState().generateStream([{ role: 'tool', toolCallId: 'a', content: 'ok' }], { onDone }, 'm', { tools })
    expect(h.invoke.mock.calls[0][2]).toMatchObject({ tools, messages: [{ toolCallId: 'a' }] })
    const step = { text: '', toolCalls: [{ id: 'b', name: 'read', arguments: {} }], terminalSeen: true, finishReason: 'tool_use' }
    h.events.get('llm:stream-done')?.({ requestId: 'other', fullText: '', step })
    expect(onDone).not.toHaveBeenCalled()
    h.events.get('llm:stream-done')?.({ requestId: id, fullText: '', step })
    expect(onDone).toHaveBeenCalledWith('', undefined, step)
    expect(useLLMStore.getState().activeRequests.size).toBe(0)
    expect(h.unsub).toHaveBeenCalledTimes(3)
  })
  it('启动失败或invoke异常清理活跃请求', async () => {
    const onError = vi.fn()
    h.invoke.mockResolvedValueOnce({ started: false })
    await useLLMStore.getState().generateStream([], { onError })
    expect(onError).toHaveBeenCalledOnce()
    expect(useLLMStore.getState().activeRequests.size).toBe(0)
    h.invoke.mockRejectedValueOnce(new Error('failed'))
    await expect(useLLMStore.getState().generateStream([], { onError })).rejects.toThrow('failed')
    expect(useLLMStore.getState().activeRequests.size).toBe(0)
  })
})
