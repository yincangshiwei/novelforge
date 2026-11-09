import { describe, expect, it, vi } from 'vitest'
import { OpenAIProvider } from './openai-provider'
import { proxyFetch } from '../net/proxy-fetch'
import type { ResolvedModelProfile } from './provider.interface'

vi.mock('../net/proxy-fetch', () => ({ proxyFetch: vi.fn() }))
const model = { modelName: 'test', baseUrl: 'https://example.com/v1', apiKey: 'test', maxTokens: 100 } as ResolvedModelProfile
const options = { temperature: 0.3, maxTokens: 100, tools: [{ name: 'read', description: 'read', parameters: { type: 'object' as const, properties: {} } }] }

describe('OpenAI原生工具', () => {
  it('预取消不发请求，执行中取消不降级或重试', async () => {
    vi.mocked(proxyFetch).mockClear()
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(new OpenAIProvider().generate(model, [], { ...options, signal: cancelled.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(proxyFetch).not.toHaveBeenCalled()
    const active = new AbortController()
    vi.mocked(proxyFetch).mockImplementationOnce(async (_url, init) => {
      expect(init?.signal).toBe(active.signal)
      active.abort()
      throw new TypeError('fetch network failed')
    })
    await expect(new OpenAIProvider().generate(model, [], { ...options, signal: active.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(proxyFetch).toHaveBeenCalledOnce()
  })
  it('退避等待中取消不发起第二次请求', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(proxyFetch).mockReset()
      vi.mocked(proxyFetch).mockResolvedValueOnce(new Response('', { status: 503 }))
      const controller = new AbortController()
      const pending = new OpenAIProvider().generate(model, [], { ...options, signal: controller.signal })
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      await vi.advanceTimersByTimeAsync(0)
      controller.abort()
      await rejected
      expect(proxyFetch).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('原生请求、纯工具响应与调用ID完整保留', async () => {
    vi.mocked(proxyFetch).mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'a', function: { name: 'read', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })))
    const result = await new OpenAIProvider().generate(model, [{ role: 'assistant', content: '', toolCalls: [{ id: 'previous', name: 'read', arguments: {} }] }, { role: 'tool', toolCallId: 'previous', content: 'result' }], options)
    expect(result.step).toMatchObject({ toolCalls: [{ id: 'a', name: 'read', arguments: {} }], finishReason: 'tool_use' })
    const body = JSON.parse(String(vi.mocked(proxyFetch).mock.calls.at(-1)?.[1]?.body))
    expect(body.tools[0].function.name).toBe('read')
    expect(body.messages[1].tool_call_id).toBe('previous')
  })
  it('流式工具不混入正文，回传结构化步骤', async () => {
    const frames = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'read', arguments: '{}' } }] } }] },
      { choices: [{ finish_reason: 'tool_calls' }] },
      { usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
    ].map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n'
    vi.mocked(proxyFetch).mockResolvedValueOnce(new Response(frames))
    const onDone = vi.fn(), onChunk = vi.fn(), onError = vi.fn()
    await new OpenAIProvider().generateStream(model, [], { ...options, signal: new AbortController().signal, onDone, onChunk, onError })
    expect(onError).not.toHaveBeenCalled()
    expect(onChunk).not.toHaveBeenCalled()
    expect(onDone.mock.calls[0][2]).toMatchObject({ toolCalls: [{ id: 'a' }], terminalSeen: true })
    expect(onDone.mock.calls[0][1]).toMatchObject({ totalTokens: 3 })
  })
  it('异常EOF不按成功交付', async () => {
    vi.mocked(proxyFetch).mockResolvedValueOnce(new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'))
    const onDone = vi.fn(), onError = vi.fn()
    await new OpenAIProvider().generateStream(model, [], { ...options, signal: new AbortController().signal, onDone, onChunk: vi.fn(), onError })
    expect(onDone).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledOnce()
  })
})
