import { createParser } from 'eventsource-parser'
import { proxyFetch } from '../net/proxy-fetch'
import { withRetry, withStreamRetry } from './retry-handler'
import type { LLMGenerateOptions, LLMStreamOptions, LLMResponse, ResolvedModelProfile, LLMUsage } from './provider.interface'
import { normalizeFinishReason, validateToolCalls, type LLMChatMessage, type LLMStepResult } from '../../src/shared/llm-tool-protocol'

type Block = { type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; functionCall?: { id?: string; name: string; args: Record<string, unknown> }; thoughtSignature?: string; thought?: boolean }
type Payload = {
  type?: string; index?: number; content_block?: Block; content?: Block[]; stop_reason?: string;
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { input_tokens?: number; output_tokens?: number };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  candidates?: Array<{ content?: { parts?: Block[] }; finishReason?: string }>;
  error?: { message?: string };
}

export function nativeRequest(protocol: 'anthropic' | 'gemini', model: ResolvedModelProfile, messages: LLMChatMessage[], opts: LLMGenerateOptions, stream: boolean): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
  const tools = opts.tools ?? []
  if (protocol === 'anthropic') {
    const body = {
      model: model.modelName, max_tokens: opts.maxTokens, stream,
      temperature: Math.min(1, Math.max(0, opts.temperature)), ...(system ? { system } : {}),
      tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      ...(opts.toolChoice === 'required' ? { tool_choice: { type: 'any' } } : opts.toolChoice === 'none' ? { tool_choice: { type: 'none' } } : { tool_choice: { type: 'auto' } }),
      messages: messages.filter(m => m.role !== 'system').map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.role === 'tool'
          ? [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }]
          : m.toolCalls?.length
            ? [...(m.content ? [{ type: 'text', text: m.content }] : []), ...m.toolCalls.map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments }))]
            : m.content,
      })),
    }
    return { url: `${model.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/messages`, headers: { 'Content-Type': 'application/json', 'x-api-key': model.apiKey, 'anthropic-version': '2023-06-01' }, body }
  }
  const body = {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    generationConfig: { maxOutputTokens: opts.maxTokens, ...(opts.thinking ? { thinkingConfig: { includeThoughts: true } } : { temperature: opts.temperature }) },
    tools: [{ functionDeclarations: tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }],
    toolConfig: { functionCallingConfig: { mode: opts.toolChoice === 'required' ? 'ANY' : opts.toolChoice === 'none' ? 'NONE' : 'AUTO' } },
    contents: messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: m.role === 'tool'
        ? [{ functionResponse: { id: m.toolCallId, name: m.name, response: { result: m.content } } }]
        : [...(m.content ? [{ text: m.content }] : []), ...(m.toolCalls ?? []).map(c => ({ functionCall: { id: c.id, name: c.name, args: c.arguments }, ...c.providerMetadata }))],
    })),
  }
  return { url: `${model.baseUrl.replace(/\/$/, '')}/v1beta/models/${model.modelName}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': model.apiKey }, body }
}

export async function generateNative(protocol: 'anthropic' | 'gemini', model: ResolvedModelProfile, messages: LLMChatMessage[], opts: LLMGenerateOptions): Promise<LLMResponse> {
  return withRetry(async () => {
    if (opts.signal?.aborted) throw new DOMException('Operation cancelled', 'AbortError')
    const req = nativeRequest(protocol, model, messages, opts, false)
    const res = await proxyFetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: opts.signal })
    if (opts.signal?.aborted) throw new DOMException('Operation cancelled', 'AbortError')
    if (!res.ok) throw Object.assign(new Error(`模型请求失败：HTTP ${res.status}`), { status: res.status })
    const data = await res.json() as Payload
    if (opts.signal?.aborted) throw new DOMException('Operation cancelled', 'AbortError')
    const blocks = protocol === 'anthropic' ? data.content ?? [] : data.candidates?.[0]?.content?.parts ?? []
    const text = blocks.filter(b => !b.thought && (b.type === 'text' || b.text !== undefined)).map(b => b.text ?? '').join('')
    const toolCalls = validateToolCalls(blocks.flatMap(b => {
      if (b.type === 'tool_use') return [{ id: b.id!, name: b.name!, arguments: b.input! }]
      if (b.functionCall) return [{ id: b.functionCall.id ?? crypto.randomUUID(), name: b.functionCall.name, arguments: b.functionCall.args, providerMetadata: b.thoughtSignature ? { thoughtSignature: b.thoughtSignature } : undefined }]
      return []
    }))
    const reason = protocol === 'anthropic' ? data.stop_reason : data.candidates?.[0]?.finishReason
    const usage: LLMUsage | undefined = protocol === 'anthropic' && data.usage
      ? { promptTokens: data.usage.input_tokens ?? 0, completionTokens: data.usage.output_tokens ?? 0, totalTokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0) }
      : data.usageMetadata ? { promptTokens: data.usageMetadata.promptTokenCount ?? 0, completionTokens: data.usageMetadata.candidatesTokenCount ?? 0, totalTokens: data.usageMetadata.totalTokenCount ?? 0 } : undefined
    return { success: true, content: text, usage, step: { text, toolCalls, finishReason: normalizeFinishReason(reason), terminalSeen: Boolean(reason) } }
  }, { signal: opts.signal }).catch(error => {
    if (opts.signal?.aborted || (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError')) {
      throw new DOMException('Operation cancelled', 'AbortError')
    }
    return { success: false, content: '', error: String(error) }
  })
}

export async function streamNative(protocol: 'anthropic' | 'gemini', model: ResolvedModelProfile, messages: LLMChatMessage[], opts: LLMStreamOptions): Promise<void> {
  let emitted = false
  await withStreamRetry(async () => {
    const req = nativeRequest(protocol, model, messages, opts, true)
    const res = await proxyFetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: opts.signal })
    if (opts.signal?.aborted) throw new DOMException('Operation cancelled', 'AbortError')
    if (!res.ok) throw Object.assign(new Error(`模型请求失败：HTTP ${res.status}`), { status: res.status })
    const reader = res.body?.getReader()
    if (!reader) throw new Error('模型流不可读')
    const step: LLMStepResult = { text: '', toolCalls: [], finishReason: 'unknown', terminalSeen: false }
    const buffers = new Map<number, { id: string; name: string; args: string; input?: Record<string, unknown> }>()
    let usage: LLMUsage | undefined
    let streamError: Error | undefined
    const parser = createParser({ onEvent: event => {
      try {
        const p = JSON.parse(event.data) as Payload
        if (p.error) throw new Error(p.error.message ?? '模型流错误')
        if (protocol === 'anthropic') {
          if (p.type === 'message_start') {
            usage = { promptTokens: p.message?.usage?.input_tokens ?? 0, completionTokens: 0, totalTokens: 0 }
          }
          if (p.type === 'content_block_start' && p.content_block?.type === 'tool_use') {
            emitted = true
            buffers.set(p.index!, { id: p.content_block.id!, name: p.content_block.name!, args: '', input: p.content_block.input })
          }
          if (p.type === 'content_block_delta') {
            if (p.delta?.type === 'text_delta') {
              step.text += p.delta.text ?? ''; emitted = true; opts.onChunk(p.delta.text ?? '')
            }
            if (p.delta?.type === 'input_json_delta') {
              const b = buffers.get(p.index!)
              if (!b) throw new Error('工具参数没有对应调用')
              b.args += p.delta.partial_json ?? ''
              if (b.args.length > 512 * 1024) throw new Error('工具参数超过上限')
            }
          }
          if (p.type === 'message_delta') {
            step.finishReason = normalizeFinishReason(p.delta?.stop_reason)
            if (usage) { usage.completionTokens = p.usage?.output_tokens ?? 0; usage.totalTokens = usage.promptTokens + usage.completionTokens }
          }
          if (p.type === 'message_stop') step.terminalSeen = true
        } else {
          const candidate = p.candidates?.[0]
          for (const b of candidate?.content?.parts ?? []) {
            if (b.text && !b.thought) { step.text += b.text; emitted = true; opts.onChunk(b.text) }
            if (b.functionCall) {
              emitted = true
              step.toolCalls.push({ id: b.functionCall.id ?? crypto.randomUUID(), name: b.functionCall.name, arguments: b.functionCall.args, providerMetadata: b.thoughtSignature ? { thoughtSignature: b.thoughtSignature } : undefined })
            }
          }
          if (candidate?.finishReason) { step.finishReason = normalizeFinishReason(candidate.finishReason); step.terminalSeen = true }
          if (p.usageMetadata) usage = { promptTokens: p.usageMetadata.promptTokenCount ?? 0, completionTokens: p.usageMetadata.candidatesTokenCount ?? 0, totalTokens: p.usageMetadata.totalTokenCount ?? 0 }
        }
      } catch (error) { streamError = error instanceof Error ? error : new Error(String(error)) }
    } })
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (opts.signal?.aborted) throw new DOMException('Operation cancelled', 'AbortError')
        if (done) break
        parser.feed(decoder.decode(value, { stream: true }))
        if (streamError) throw streamError
      }
      parser.feed(decoder.decode())
      if (streamError) throw streamError
      if (!step.terminalSeen || !['stop', 'tool_use'].includes(step.finishReason)) throw new Error(`模型输出未正常结束：${step.finishReason}`)
      for (const b of buffers.values()) step.toolCalls.push({ id: b.id, name: b.name, arguments: b.args ? JSON.parse(b.args) : b.input ?? {} })
      validateToolCalls(step.toolCalls)
      if (opts.signal?.aborted) throw new DOMException('Operation cancelled', 'AbortError')
      opts.onDone(step.text, usage, step)
    } finally { reader.releaseLock() }
  }, { signal: opts.signal, canRetry: () => !emitted }).catch(error => opts.onError(String(error)))
}
