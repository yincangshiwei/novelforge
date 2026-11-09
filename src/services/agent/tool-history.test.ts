import { describe, expect, it } from 'vitest'
import { toolHistoryGroup } from './tool-history'
import { textProtocolMessages } from '../../shared/llm-tool-protocol'

describe('工具历史回放', () => {
  it('按调用ID保留成功与失败结果，不回放未执行的pending调用', () => {
    const group = toolHistoryGroup({ id: 'm', role: 'assistant', content: '总结', createdAt: 0, toolCalls: [
      { id: 'a', toolName: 'read', arguments: {}, status: 'completed', result: 'ok', providerMetadata: { thoughtSignature: 'sig' } },
      { id: 'b', toolName: 'write', arguments: {}, status: 'failed', error: '拒绝' },
      { id: 'c', toolName: 'write', arguments: {}, status: 'pending' },
    ] })
    expect(group.map(m => m.role)).toEqual(['assistant', 'tool', 'tool', 'assistant'])
    expect(group[0].toolCalls?.map(c => c.id)).toEqual(['a', 'b'])
    expect(group[0].toolCalls?.[0].providerMetadata).toEqual({ thoughtSignature: 'sig' })
    expect(group[1].toolCallId).toBe('a')
    expect(group[2].content).toContain('拒绝')
    expect(group[3].content).toBe('总结')
  })
  it('文本兼容模式不发送原生tool角色且保留执行事实', () => {
    const group = toolHistoryGroup({ id: 'm', role: 'assistant', content: '', createdAt: 0, toolCalls: [{ id: 'a', toolName: 'read', arguments: {}, status: 'completed', result: 'ok' }] })
    const compat = textProtocolMessages(group)
    expect(compat.every(m => m.role !== 'tool' && !m.toolCalls)).toBe(true)
    expect(compat[1].content).toContain('id=a')
    expect(compat[1].content).toContain('ok')
  })
})
