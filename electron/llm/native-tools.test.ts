import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nativeRequest, streamNative, generateNative } from './native-tools'
import type { ResolvedModelProfile } from './provider.interface'
import { proxyFetch } from '../net/proxy-fetch'
import { OpenAIProvider } from './openai-provider'
import { AnthropicProvider } from './anthropic-provider'
import { GeminiProvider } from './gemini-provider'

vi.mock('../net/proxy-fetch', () => ({ proxyFetch: vi.fn() }))
const model = { modelName: 'test', baseUrl: 'https://example.com', apiKey: 'test', maxTokens: 100 } as ResolvedModelProfile
const opts = { temperature: 0.3, maxTokens: 100, tools: [{ name: 'read', description: 'read', parameters: { type: 'object' as const, properties: {} } }] }
const messages = [
  { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read', arguments: { path: 'a.md' }, providerMetadata: { thoughtSignature: 'sig' } }] },
  { role: 'tool', content: 'result', toolCallId: 'a', name: 'read' },
]
function response(events: unknown[]): Response {
  return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
}

beforeEach(() => { vi.mocked(proxyFetch).mockReset() })

describe('原生工具非流式取消', () => {
  it.each(['anthropic', 'gemini'] as const)('%s预取消不发请求', async (protocol) => {
    const controller = new AbortController()
    controller.abort()
    await expect(generateNative(protocol, model, [], { ...opts, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(proxyFetch).not.toHaveBeenCalled()
  })

  it.each(['anthropic', 'gemini'] as const)('%s运行取消传递signal且不重试', async (protocol) => {
    const controller = new AbortController()
    vi.mocked(proxyFetch).mockImplementationOnce((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })
    }))
    const pending = generateNative(protocol, model, [], { ...opts, signal: controller.signal })
    expect(vi.mocked(proxyFetch).mock.calls[0][1]?.signal).toBe(controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(proxyFetch).toHaveBeenCalledTimes(1)
  })

  it.each(['anthropic', 'gemini'] as const)('%s解析响应期间取消不回传工具调用', async (protocol) => {
    const controller = new AbortController()
    const res = new Response('{}')
    vi.spyOn(res, 'json').mockImplementationOnce(async () => {
      controller.abort()
      return { content: [{ type: 'tool_use', id: 'a', name: 'read', input: {} }], stop_reason: 'tool_use', candidates: [{ content: { parts: [{ functionCall: { id: 'a', name: 'read', args: {} } }] }, finishReason: 'STOP' }] }
    })
    vi.mocked(proxyFetch).mockResolvedValueOnce(res)
    await expect(generateNative(protocol, model, [], { ...opts, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(proxyFetch).toHaveBeenCalledTimes(1)
  })
})

describe.each([
  ['openai', new OpenAIProvider()],
  ['anthropic', new AnthropicProvider()],
  ['gemini', new GeminiProvider()],
] as const)('%s流式取消终态', (protocol, provider) => {
  it.each([false, true])('工具开关%s：EOF晚到不得onDone', async (tools) => {
    const controller = new AbortController()
    const events = protocol === 'openai'
      ? [{ choices: [{ delta: { content: 'text' } }] }, { choices: [{ finish_reason: 'stop' }] }]
      : protocol === 'anthropic'
        ? [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'text' } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }]
        : [{ candidates: [{ content: { parts: [{ text: 'text' }] }, finishReason: 'STOP' }] }]
    const frames = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + (protocol === 'openai' ? 'data: [DONE]\n\n' : '')
    let reads = 0
    const reader = {
      read: vi.fn(async () => {
        if (reads++ === 0) return { done: false, value: new TextEncoder().encode(frames) }
        controller.abort()
        return { done: true, value: undefined }
      }),
      releaseLock: vi.fn(),
    }
    const res = new Response('')
    vi.spyOn(res.body!, 'getReader').mockReturnValue(reader as unknown as ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>)
    vi.mocked(proxyFetch).mockResolvedValueOnce(res)
    const onDone = vi.fn(), onError = vi.fn()
    await provider.generateStream(model, [], { ...opts, tools: tools ? opts.tools : undefined, signal: controller.signal, onChunk: vi.fn(), onDone, onError })
    expect(onDone).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledOnce()
    expect(proxyFetch).toHaveBeenCalledOnce()
  })
})

describe('原生工具重试', () => {
  it.each(['anthropic', 'gemini'] as const)('%s HTTP 503同源重试，401不重试', async (protocol) => {
    vi.useFakeTimers()
    try {
      vi.mocked(proxyFetch).mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(new Response('{}'))
      const pending = generateNative(protocol, model, [], opts)
      await vi.runAllTimersAsync()
      expect(await pending).toMatchObject({ success: true })
      expect(proxyFetch).toHaveBeenCalledTimes(2)
      expect(vi.mocked(proxyFetch).mock.calls[0][0]).toBe(vi.mocked(proxyFetch).mock.calls[1][0])
      vi.mocked(proxyFetch).mockReset()
      vi.mocked(proxyFetch).mockResolvedValueOnce(new Response('', { status: 401 }))
      expect(await generateNative(protocol, model, [], opts)).toMatchObject({ success: false })
      expect(proxyFetch).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })

  it.each(['anthropic', 'gemini'] as const)('%s流式HTTP 503可重试', async (protocol) => {
    vi.useFakeTimers()
    try {
      const terminal = protocol === 'anthropic' ? [{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }] : [{ candidates: [{ finishReason: 'STOP' }] }]
      vi.mocked(proxyFetch).mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(response(terminal))
      const onDone = vi.fn(), onError = vi.fn()
      const pending = streamNative(protocol, model, [], { ...opts, signal: new AbortController().signal, onDone, onError, onChunk: vi.fn() })
      await vi.runAllTimersAsync()
      await pending
      expect(proxyFetch).toHaveBeenCalledTimes(2)
      expect(onDone).toHaveBeenCalledOnce()
      expect(onError).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })
})

describe('原生工具协议', () => {
  it('Anthropic调用与结果按ID配对', () => {
    const req = nativeRequest('anthropic', model, messages, opts, true)
    expect(req.body.messages).toMatchObject([{ content: [{ type: 'tool_use', id: 'a', name: 'read' }] }, { content: [{ type: 'tool_result', tool_use_id: 'a' }] }])
    expect(req.body.tools).toMatchObject([{ name: 'read', input_schema: { type: 'object' } }])
  })
  it('Gemini保留签名和函数结果', () => {
    const req = nativeRequest('gemini', model, messages, opts, true)
    expect(req.body.contents).toMatchObject([{ parts: [{ functionCall: { id: 'a' }, thoughtSignature: 'sig' }] }, { parts: [{ functionResponse: { id: 'a', name: 'read' } }] }])
  })
  it('Anthropic纯工具流收齐参数与结束帧才回传', async () => {
    vi.mocked(proxyFetch).mockResolvedValueOnce(response([
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a', name: 'read', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"a.md"}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ]))
    const onDone = vi.fn(), onError = vi.fn()
    await streamNative('anthropic', model, [], { ...opts, signal: new AbortController().signal, onChunk: vi.fn(), onDone, onError })
    expect(onError).not.toHaveBeenCalled()
    expect(onDone.mock.calls[0][2]).toMatchObject({ terminalSeen: true, toolCalls: [{ id: 'a', arguments: { path: 'a.md' } }] })
  })
  it.each(['缺失结束帧', '截断参数'])('%s不得回传可执行调用', async (kind) => {
    const frames: unknown[] = [
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a', name: 'read', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{' } },
    ]
    if (kind === '截断参数') frames.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' })
    vi.mocked(proxyFetch).mockResolvedValueOnce(response(frames))
    const onDone = vi.fn(), onError = vi.fn()
    await streamNative('anthropic', model, [], { ...opts, signal: new AbortController().signal, onChunk: vi.fn(), onDone, onError })
    expect(onDone).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledOnce()
  })
  it('Gemini遍历所有part并保留签名', async () => {
    vi.mocked(proxyFetch).mockResolvedValueOnce(response([{ candidates: [{ content: { parts: [{ text: '读取' }, { functionCall: { id: 'a', name: 'read', args: {} }, thoughtSignature: 'sig' }] }, finishReason: 'STOP' }] }]))
    const onDone = vi.fn()
    await streamNative('gemini', model, [], { ...opts, signal: new AbortController().signal, onChunk: vi.fn(), onDone, onError: vi.fn() })
    expect(onDone.mock.calls[0][2]).toMatchObject({ text: '读取', toolCalls: [{ id: 'a', providerMetadata: { thoughtSignature: 'sig' } }] })
  })
  it('非流式工具-only响应保留调用', async () => {
    vi.mocked(proxyFetch).mockResolvedValueOnce(new Response(JSON.stringify({ content: [{ type: 'tool_use', id: 'a', name: 'read', input: {} }], stop_reason: 'tool_use' })))
    expect(await generateNative('anthropic', model, [], opts)).toMatchObject({ success: true, content: '', step: { toolCalls: [{ id: 'a' }] } })
  })
})
