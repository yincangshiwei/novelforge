import { describe, expect, it } from 'vitest'
import { unsupportedMutationClaims, type ExecutionReceipt } from './execution-evidence'
import type { ToolCallInfo } from './agent-engine'

function saved(field: string, outcome: ExecutionReceipt['outcome'] = 'committed'): ToolCallInfo {
  return {
    id: field, turnId: 'turn', toolName: 'update_config', arguments: { field }, status: outcome === 'committed' ? 'completed' : 'failed',
    receipt: { turnId: 'turn', step: 1, callId: field, toolName: 'update_config', target: `config:${field}`, outcome, verified: true },
  }
}

describe('修改完成执行证据', () => {
  it('零工具不能声称已补充到三个位置', () => {
    expect(unsupportedMutationClaims('已经写进了 3 个核心位置。', [])).toHaveLength(1)
    expect(unsupportedMutationClaims('已补充全局写作要求。', [])).toHaveLength(1)
  })
  it('一个字段不能支持其他字段或三个位置的完成声明', () => {
    expect(unsupportedMutationClaims('已更新全局写作要求和写作风格。', [saved('globalGuidance')])).toHaveLength(1)
    expect(unsupportedMutationClaims('已写进了3个核心位置。', [saved('globalGuidance')])).toHaveLength(1)
  })
  it('对应字段回读核验成功才接受', () => {
    expect(unsupportedMutationClaims('已更新全局写作要求和写作风格。', [saved('globalGuidance'), saved('writingStyle')])).toEqual([])
  })
  it('只读成功、失败、伪造回执不能替代保存', () => {
    const read: ToolCallInfo = { id: 'read', toolName: 'read_project_state', arguments: {}, status: 'completed' }
    expect(unsupportedMutationClaims('已更新小说配置。', [read])).toHaveLength(1)
    expect(unsupportedMutationClaims('已更新全局写作要求。', [saved('globalGuidance', 'failed')])).toHaveLength(1)
    const mismatched = saved('globalGuidance')
    mismatched.turnId = 'other'
    expect(unsupportedMutationClaims('已更新全局写作要求。', [mismatched])).toHaveLength(1)
  })
  it('普通咨询、否定、计划和无需修改不误判', () => {
    for (const text of ['建议更新小说配置。', '我准备补充全局写作要求。', '未更新小说配置。', '已检查配置，无需修改。', '下面是补充建议。']) {
      expect(unsupportedMutationClaims(text, [])).toEqual([])
    }
  })
})
