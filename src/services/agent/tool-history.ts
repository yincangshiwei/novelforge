import type { AgentMessage } from '../../stores/agent-store'
import type { LLMMessage } from './agent-engine'

export function toolHistoryGroup(message: AgentMessage): LLMMessage[] {
  const calls = (message.toolCalls ?? []).filter(c => c.status === 'completed' || c.status === 'failed')
  if (!calls.length) return [{ role: message.role, content: message.content }]
  return [
    { role: 'assistant', content: '[历史执行记录，不代表本轮已执行]', toolCalls: calls.map(c => ({ id: c.id, name: c.toolName, arguments: c.arguments, providerMetadata: c.providerMetadata })) },
    ...calls.map(c => ({ role: 'tool' as const, toolCallId: c.id, name: c.toolName, content: JSON.stringify({ status: c.status, result: c.result, error: c.error, receipt: c.receipt }) })),
    ...(message.content ? [{ role: 'assistant' as const, content: message.content }] : []),
  ]
}
