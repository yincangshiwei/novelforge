export interface LLMToolDefinition {
  name: string
  description: string
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
}

export interface LLMToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  providerMetadata?: Record<string, unknown>
}

export interface LLMChatMessage {
  role: string
  content: string
  toolCalls?: LLMToolCall[]
  toolCallId?: string
  name?: string
}

export type LLMFinishReason = 'stop' | 'tool_use' | 'length' | 'error' | 'unknown'
export interface LLMStepResult {
  text: string
  toolCalls: LLMToolCall[]
  finishReason: LLMFinishReason
  terminalSeen: boolean
}

export type LLMToolChoice = 'auto' | 'required' | 'none'

export function validateToolCalls(calls: LLMToolCall[]): LLMToolCall[] {
  if (calls.length > 32) throw new Error('模型单步工具调用超过32个')
  const ids = new Set<string>()
  for (const call of calls) {
    if (!call.id || ids.has(call.id) || !call.name || !call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) {
      throw new Error('模型工具调用格式无效或调用ID重复')
    }
    if (JSON.stringify(call.arguments).length > 512 * 1024) throw new Error('模型工具参数超过大小上限')
    ids.add(call.id)
  }
  return calls
}

export function toOpenAIMessages(messages: LLMChatMessage[]): Record<string, unknown>[] {
  return messages.map(m => ({
    role: m.role,
    content: m.content,
    ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}),
    ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
  }))
}

export function textProtocolMessages(messages: LLMChatMessage[]): LLMChatMessage[] {
  return messages.map(m => m.role === 'tool'
    ? { role: 'user', content: `[历史工具结果 id=${m.toolCallId} name=${m.name}]\n${m.content}` }
    : { role: m.role, content: m.toolCalls?.length ? `${m.content}\n[历史工具调用]\n${JSON.stringify(m.toolCalls)}` : m.content })
}

export function normalizeFinishReason(reason: string | undefined): LLMFinishReason {
  if (['tool_calls', 'tool_use'].includes(reason ?? '')) return 'tool_use'
  if (['length', 'max_tokens', 'MAX_TOKENS'].includes(reason ?? '')) return 'length'
  if (['stop', 'end_turn', 'stop_sequence', 'STOP'].includes(reason ?? '')) return 'stop'
  return reason ? 'error' : 'unknown'
}

export function toolsForOpenAI(tools: LLMToolDefinition[]): Record<string, unknown>[] {
  return tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))
}
