import { describe, expect, it } from 'vitest'
import { recoverConversationOperations, recoverOperationEvidence } from './operation-recovery'
import type { AgentConversation } from '../../stores/agent-store'
import type { AgentOperationRecord } from '../../shared/agent-operation-protocol'

const record: AgentOperationRecord = { operationId: 'c:ipc:0', callId: 'c', turnId: 't', conversationId: 'conv', scope: '/synthetic', toolName: 'write_file', channel: 'fs:write-file', target: 'a.txt', state: 'committed', updatedAt: 1 }
describe('操作证据恢复', () => {
  it('归档无工具记录时恢复证据但不冒充任务完成', () => {
    const messages = recoverOperationEvidence([], [record])
    expect(messages[0].toolCalls?.[0].receipt?.outcome).toBe('committed')
    expect(messages[0].content).toContain('不代表整个任务已完成')
    expect(messages[0].streaming).toBe(false)
  })
  it('已有unknown调用核对提交后纠正，不追加重复记录', () => {
    const messages = recoverOperationEvidence([{ id: 'm', role: 'assistant', content: '', createdAt: 0, toolCalls: [{ id: 'c', toolName: 'write_file', arguments: {}, status: 'failed', receipt: { turnId: 't', callId: 'c', step: 1, toolName: 'write_file', target: 'a.txt', outcome: 'unknown', verified: false } }] }], [record])
    expect(messages).toHaveLength(1)
    expect(messages[0].toolCalls?.[0].status).toBe('completed')
    expect(messages[0].toolCalls?.[0].receipt?.outcome).toBe('committed')
  })
  it.each([true, false])('子调用已有转录=%s：仅纠正子证据，不补到父消息', hasTranscript => {
    const call = recoverOperationEvidence([], [{ ...record, state: 'unknown' }])[0].toolCalls![0]
    const conversation: AgentConversation = {
      id: 'conv', title: '恢复', modelId: null, messages: [], createdAt: 0, updatedAt: 0,
      subSessions: [{ id: 'child', taskId: 'child', description: '', prompt: '', allowedTools: [],
        status: 'cancelled', result: '', startedAt: 0, artifacts: [], toolCalls: [call],
        messages: hasTranscript ? [{ id: 'child-message', role: 'assistant', content: '', createdAt: 0, toolCalls: [call] }] : [],
      }],
    }
    const recovered = recoverConversationOperations(conversation, [record])
    expect(recovered.messages).toHaveLength(0)
    expect(recovered.subSessions![0].toolCalls).toHaveLength(1)
    expect(recovered.subSessions![0].toolCalls[0].receipt?.outcome).toBe('committed')
    expect(recovered.subSessions![0].messages[0].toolCalls![0].receipt?.outcome).toBe('committed')
    expect(recovered.subSessions![0].status).toBe('cancelled')
  })
  it('仍有未知子操作不标完整提交', () => {
    const messages = recoverOperationEvidence([], [record, { ...record, operationId: 'c:ipc:1', state: 'unknown' }])
    expect(messages[0].toolCalls?.[0].receipt?.outcome).toBe('unknown')
    expect(messages[0].content).toContain('未自动重放')
  })
})
