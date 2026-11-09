import type { AgentOperationRecord } from '../../shared/agent-operation-protocol'
import type { AgentConversation, AgentMessage } from '../../stores/agent-store'

export function recoverOperationEvidence(messages: AgentMessage[], records: readonly AgentOperationRecord[]): AgentMessage[] {
  const known = new Set(messages.flatMap(m => m.toolCalls ?? []).map(call => call.id))
  const grouped = new Map<string, AgentOperationRecord[]>()
  for (const record of records) {
    const group = grouped.get(record.callId) ?? []
    group.push(record)
    grouped.set(record.callId, group)
  }
  const recovered: AgentMessage[] = []
  for (const [callId, group] of grouped) {
    if (known.has(callId)) continue
    const last = group[group.length - 1]
    const unknown = group.some(record => record.state === 'running' || record.state === 'unknown')
    const committed = group.some(record => record.state === 'committed')
    const outcome = unknown ? 'unknown' : committed ? 'committed' : 'failed'
    recovered.push({
      id: `recovered-operation-${callId}`, role: 'assistant', createdAt: last.updatedAt,
      content: unknown ? '发现中断的执行记录：提交状态待核对，未自动重放。' : committed
        ? '恢复了已提交操作的执行证据；原任务总结未完整保存，不代表整个任务已完成。' : '恢复了未提交操作的执行记录，未自动重放。',
      streaming: false,
      toolCalls: [{ id: callId, toolName: last.toolName, arguments: {}, turnId: last.turnId,
        status: outcome === 'committed' ? 'completed' : 'failed',
        result: group.map(record => `${record.channel}: ${record.state}`).join('\n'),
        receipt: { callId, turnId: last.turnId, step: 0, toolName: last.toolName,
          target: last.target ?? last.channel, outcome, verified: outcome === 'committed', projectPath: last.scope },
      }],
    })
  }
  const updated = messages.map(message => ({ ...message, toolCalls: message.toolCalls?.map(call => {
    const records = grouped.get(call.id)
    if (!records || call.receipt?.outcome !== 'unknown') return call
    if (records.some(record => record.state === 'unknown' || record.state === 'running')) return call
    const committed = records.some(record => record.state === 'committed')
    return { ...call, status: committed ? 'completed' as const : 'failed' as const,
      result: records.map(record => `${record.channel}: ${record.state}`).join('\n'),
      receipt: { ...call.receipt, outcome: committed ? 'committed' as const : 'failed' as const, verified: committed },
    }
  }) }))
  return [...updated, ...recovered]
}

export function recoverConversationOperations(conversation: AgentConversation, records: readonly AgentOperationRecord[]): AgentConversation {
  const childCallIds = new Set((conversation.subSessions ?? []).flatMap(session => [
    ...session.toolCalls, ...session.messages.flatMap(message => message.toolCalls ?? []),
  ]).map(call => call.id))
  const subSessions = conversation.subSessions?.map(session => {
    const ids = new Set([...session.toolCalls, ...session.messages.flatMap(message => message.toolCalls ?? [])].map(call => call.id))
    const owned = records.filter(record => ids.has(record.callId))
    const messages = recoverOperationEvidence(session.messages, owned)
    const carrier: AgentMessage = { id: 'recovery-carrier', role: 'assistant', content: '', createdAt: 0, toolCalls: session.toolCalls }
    const toolCalls = recoverOperationEvidence([carrier], owned).flatMap(message => message.toolCalls ?? [])
    return { ...session, messages, toolCalls }
  })
  const parentIds = new Set(conversation.messages.flatMap(message => message.toolCalls ?? []).map(call => call.id))
  const messages = recoverOperationEvidence(conversation.messages, records.filter(record => !childCallIds.has(record.callId)))
    .map(message => message.id.startsWith('recovered-operation-') && message.toolCalls?.some(call => !parentIds.has(call.id))
      ? { ...message, content: `此操作归属未完整保存，以下仅为会话级恢复证据，不判定为父任务或子任务完成。\n${message.content}` }
      : message)
  return { ...conversation, subSessions, messages }
}
