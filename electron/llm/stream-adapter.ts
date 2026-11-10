/**
 * StreamAdapter —— 厂商 SSE → InternalStreamEvent。
 *
 * P0：OpenAI-compatible（OpenAI / DeepSeek Chat / Qwen / GLM / 豆包 / 混元 / 阶跃）。
 * 业务层不再解析 delta/choices/[DONE]；换模型只换 Adapter。
 */
import { createParser } from 'eventsource-parser'
import type { InternalStreamAdapter, InternalStreamEvent, InternalStreamFinishReason } from '../../src/shared/llm-stream-events'
import type { LLMUsage } from './provider.interface'
import { logger } from '../utils/logger'

interface ToolBuffer {
  id: string
  name: string
  args: string
}

function mapUsage(usage: Record<string, unknown> | undefined): LLMUsage | undefined {
  if (!usage) return undefined
  return {
    promptTokens: Number(usage.prompt_tokens ?? 0),
    completionTokens: Number(usage.completion_tokens ?? 0),
    totalTokens: Number(usage.total_tokens ?? 0),
    cachedTokens: Number(
      (usage.prompt_cache_hit_tokens as number | undefined)
      ?? (usage.prompt_tokens_details as { cached_tokens?: number } | undefined)?.cached_tokens
      ?? 0,
    ),
  }
}

export class OpenAICompatibleStreamAdapter implements InternalStreamAdapter {
  private parser: ReturnType<typeof createParser>
  private started = false
  private finished = false
  private finishReason: InternalStreamFinishReason = 'unknown'
  private usage: LLMUsage | undefined
  private readonly tools = new Map<number, ToolBuffer>()
  private warnedUnknownShape = false
  private doneSeen = false
  private finishReasonSeen = false
  private malformedEvents = 0
  private eventCount = 0

  getDiagnostics() {
    return { doneSeen: this.doneSeen, finishReasonSeen: this.finishReasonSeen, malformedEvents: this.malformedEvents, events: this.eventCount }
  }

  constructor(private readonly modelName: string) {
    this.parser = createParser({
      onEvent: (event) => {
        const data = event.data.trim()
        if (!data) return
        this.eventCount++
        if (data === '[DONE]') {
          this.doneSeen = true
          this.completeToolsAndFinish()
          return
        }
        let parsed: Record<string, unknown>
        try { parsed = JSON.parse(data) as Record<string, unknown> } catch { this.malformedEvents++; return }
        this.handlePayload(parsed)
      },
    })
  }

  private handlePayload(payload: Record<string, unknown>): void {
    if (payload.error) {
      const err = payload.error as { message?: string; code?: string; status?: number }
      const status = Number(err.status ?? 0)
      this.events.push({
        type: 'error',
        message: String(err.message ?? 'stream error'),
        retryable: status === 429 || status >= 500,
      })
      this.finishReason = 'error'
      return
    }

    this.usage = mapUsage(payload.usage as Record<string, unknown> | undefined) ?? this.usage

    const choices = payload.choices as Array<Record<string, unknown>> | undefined
    const choice = choices?.[0]
    if (!choice) {
      if (!this.warnedUnknownShape && !payload.usage) {
        this.warnedUnknownShape = true
        logger.warn('LLM:Adapter', `未识别的流事件形状 model=${this.modelName} keys=${Object.keys(payload).join(',')}；如需支持请在 https://github.com/LunaRime/novelforge/issues 提交议题（附此日志与 provider/protocol）`)
      }
      return
    }
    const delta = choice.delta as Record<string, unknown> | undefined
    if (delta) {
      const reasoning = delta.reasoning_content ?? delta.reasoning
      if (typeof reasoning === 'string' && reasoning) {
        this.events.push({ type: 'reasoning_delta', delta: reasoning })
      }
      if (typeof delta.content === 'string' && delta.content) {
        this.events.push({ type: 'text_delta', delta: delta.content })
      }
      const toolDeltas = delta.tool_calls as Array<Record<string, unknown>> | undefined
      if (Array.isArray(toolDeltas)) {
        for (const tc of toolDeltas) {
          const index = Number(tc.index ?? 0)
          const fn = tc.function as { name?: string; arguments?: string } | undefined
          const id = String(tc.id ?? this.tools.get(index)?.id ?? `call_${index}`)
          const prev = this.tools.get(index) ?? { id, name: '', args: '' }
          if (tc.id) prev.id = String(tc.id)
          if (fn?.name) prev.name = fn.name
          const argsDelta = fn?.arguments ?? ''
          prev.args += argsDelta
          this.tools.set(index, prev)
          this.events.push({ type: 'tool_call_delta', id, name: fn?.name, argsDelta })
        }
      }
    }

    const finish = choice.finish_reason
    if (typeof finish === 'string') {
      this.finishReasonSeen = true
      this.finishReason = finish === 'length' ? 'length'
        : ['tool_calls', 'tool_use'].includes(finish) ? 'tool_use' : finish === 'stop' ? 'stop' : 'error'
    }
  }

  private events: InternalStreamEvent[] = []

  private completeToolsAndFinish(): void {
    if (this.finished) return
    this.finished = true
    if (this.finishReason === 'stop' || this.finishReason === 'tool_use') {
      const completed: InternalStreamEvent[] = []
      try {
        if (this.tools.size > 32) throw new Error('单步工具调用超过上限')
        for (const tool of this.tools.values()) {
          const args: unknown = tool.args ? JSON.parse(tool.args) : {}
          if (!tool.name || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数不是有效对象')
          completed.push({ type: 'tool_call_complete', id: tool.id, name: tool.name, args })
        }
        this.events.push(...completed)
      } catch {
        this.finishReason = 'error'
        this.events.push({ type: 'error', message: '工具调用参数损坏，未执行任何调用', retryable: false })
      }
    }
    this.events.push({ type: 'finish', reason: this.finishReason, usage: this.usage })
  }

  push(chunk: string): InternalStreamEvent[] {
    this.events = []
    if (!this.started) {
      this.started = true
      this.events.push({ type: 'start', model: this.modelName })
    }
    this.parser.feed(chunk)
    return this.events
  }

  flush(): InternalStreamEvent[] {
    this.events = []
    this.completeToolsAndFinish()
    return this.events
  }
}

export function createStreamAdapter(protocol: string, modelName: string): InternalStreamAdapter | null {
  if (protocol === 'openai') return new OpenAICompatibleStreamAdapter(modelName)
  logger.warn('LLM:Adapter', `协议 ${protocol} 尚未接入统一流适配（model=${modelName}）；请在 https://github.com/LunaRime/novelforge/issues 提交议题，附 provider/protocol/日志`)
  return null
}
