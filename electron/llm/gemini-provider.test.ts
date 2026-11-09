import { describe, it, expect, vi } from 'vitest'
import { GeminiProvider, toGeminiContents } from './gemini-provider'
import { proxyFetch } from '../net/proxy-fetch'
import type { ResolvedModelProfile } from './provider.interface'

vi.mock('../net/proxy-fetch', () => ({ proxyFetch: vi.fn() }))
const model = { modelName: 'test', baseUrl: 'https://example.com', apiKey: 'test', maxTokens: 100 } as ResolvedModelProfile

describe('Gemini流式取消与重复保护', () => {
  it('输出后网络错误不重试', async () => {
    vi.mocked(proxyFetch).mockReset()
    let reads = 0
    vi.mocked(proxyFetch).mockResolvedValueOnce(new Response(new ReadableStream({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(new TextEncoder().encode('data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n'))
        else controller.error(new TypeError('fetch network failed'))
      },
    })))
    const onChunk = vi.fn(), onDone = vi.fn(), onError = vi.fn()
    await new GeminiProvider().generateStream(model, [], { temperature: 0.3, maxTokens: 100, signal: new AbortController().signal, onChunk, onDone, onError })
    expect(onChunk).toHaveBeenCalledExactlyOnceWith('partial')
    expect(onDone).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledOnce()
    expect(proxyFetch).toHaveBeenCalledOnce()
  })
})

describe('toGeminiContents', () => {
  it('单条 system 作为 systemInstruction，user/assistant 正确映射', () => {
    const { contents, systemInstruction } = toGeminiContents([
      { role: 'system', content: '你是一位小说家。' },
      { role: 'user', content: '写一章' },
      { role: 'assistant', content: '好的' },
      { role: 'user', content: '继续' },
    ])
    expect(systemInstruction).toBe('你是一位小说家。')
    expect(contents.map(c => c.role)).toEqual(['user', 'model', 'user'])
    expect(contents[0].parts[0].text).toBe('写一章')
  })

  it('多条 system（systemRole + staticContext）全部合并，不丢失任何一条', () => {
    const { contents, systemInstruction } = toGeminiContents([
      { role: 'system', content: '你是一位笔力精湛的顶尖网文小说家。' },
      { role: 'system', content: '【全书架构】主角是林晚。' },
      { role: 'user', content: '请创作第三章。' },
    ])
    expect(systemInstruction).toContain('顶尖网文小说家')
    expect(systemInstruction).toContain('主角是林晚')
    expect(systemInstruction).toBe('你是一位笔力精湛的顶尖网文小说家。\n\n【全书架构】主角是林晚。')
    expect(contents).toHaveLength(1)
    expect(contents[0].role).toBe('user')
  })

  it('无 system 时 systemInstruction 为 undefined', () => {
    const { contents, systemInstruction } = toGeminiContents([
      { role: 'user', content: 'hi' },
    ])
    expect(systemInstruction).toBeUndefined()
    expect(contents).toHaveLength(1)
  })

  it('空消息列表返回空 contents 且无 systemInstruction', () => {
    const { contents, systemInstruction } = toGeminiContents([])
    expect(contents).toEqual([])
    expect(systemInstruction).toBeUndefined()
  })
})
