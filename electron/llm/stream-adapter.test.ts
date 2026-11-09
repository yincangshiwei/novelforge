import { describe, expect, it } from 'vitest'
import { createStreamAdapter } from './stream-adapter'
import type { InternalStreamEvent } from '../../src/shared/llm-stream-events'

function collect(parts: string[]): InternalStreamEvent[] {
  const adapter = createStreamAdapter('openai', 'qwen-max')!
  const events: InternalStreamEvent[] = []
  for (const part of parts) events.push(...adapter.push(part))
  events.push(...adapter.flush())
  return events
}

describe('OpenAICompatibleStreamAdapter', () => {
  const sse = [
    'data: {"choices":[{"delta":{"reasoning_content":"先想"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"答案"}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.md\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"finish_reason":"tool_use"}],"usage":{"prompt_tokens":11,"completion_tokens":22,"total_tokens":33}}\n\n',
    'data: [DONE]\n\n',
  ]

  it('reasoning/content/tool 分片统一为内部事件', () => {
    const events = collect([sse.join('')])
    expect(events[0]).toEqual({ type: 'start', model: 'qwen-max' })
    expect(events).toContainEqual({ type: 'reasoning_delta', delta: '先想' })
    expect(events).toContainEqual({ type: 'text_delta', delta: '答案' })
    expect(events).toContainEqual({ type: 'tool_call_complete', id: 'c1', name: 'read_file', args: { path: 'a.md' } })
    expect(events.at(-1)).toMatchObject({ type: 'finish', reason: 'tool_use', usage: { promptTokens: 11, completionTokens: 22 } })
  })

  it('缺失结束原因与截断参数都不能产生可执行调用', () => {
    const tool = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"read","arguments":"{"}}]}}]}\n\n'
    for (const tail of ['', 'data: {"choices":[{"finish_reason":"length"}]}\n\n', 'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n']) {
      const events = collect([tool + tail])
      expect(events.some(e => e.type === 'tool_call_complete')).toBe(false)
      expect(events.at(-1)).toMatchObject({ type: 'finish', reason: tail.includes('length') ? 'length' : tail ? 'error' : 'unknown' })
    }
  })

  it('usage尾帧被保留，后到调用ID替换临时ID', () => {
    const events = collect([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"real","function":{"name":"read"}}]},"finish_reason":"tool_calls"}]}\n\n',
      'data: {"usage":{"prompt_tokens":9,"completion_tokens":1,"total_tokens":10}}\n\n',
      'data: [DONE]\n\n',
    ])
    expect(events).toContainEqual({ type: 'tool_call_complete', id: 'real', name: 'read', args: {} })
    expect(events.at(-1)).toMatchObject({ usage: { totalTokens: 10 } })
  })

  it('任意字符边界切 SSE 仍得到同一事件', () => {
    const whole = collect([sse.join('')])
    for (let i = 0; i <= sse.join('').length; i += 7) {
      const split = [sse.join('').slice(0, i), sse.join('').slice(i)]
      expect(collect(split)).toEqual(whole)
    }
  })
})
