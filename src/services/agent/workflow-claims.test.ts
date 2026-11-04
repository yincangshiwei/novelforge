import { describe, it, expect } from 'vitest'
import { unsupportedWorkflowClaims, type WorkflowClaimEvidence } from './workflow-claims'

const receipt: WorkflowClaimEvidence = {
  toolCalls: [{ id: 'call', toolName: 'start_workflow', status: 'completed', arguments: { workflow: 'generate_draft', chapter_number: 1 } }],
  artifacts: [{ type: 'workflow_started', name: '写稿', metadata: { runId: 'run-1', workflow: 'generate_draft', chapterNumber: 1 } }],
}

describe('工作流声明与真实回执匹配', () => {
  it('允许匹配章节的真实启动回执', () => {
    expect(unsupportedWorkflowClaims('已启动第 1 章 generate_draft 工作流。', receipt)).toEqual([])
  })
  it('另一章或另一种工作流回执不能证明当前声明', () => {
    expect(unsupportedWorkflowClaims('已启动第 2 章 generate_draft 工作流。', receipt)).toHaveLength(1)
    expect(unsupportedWorkflowClaims('已启动 generate_blueprint 工作流。', receipt)).toHaveLength(1)
  })
  it('失败和拒绝的调用不能证明已启动', () => {
    expect(unsupportedWorkflowClaims('已启动 generate_draft 工作流。', {
      ...receipt, toolCalls: receipt.toolCalls.map(call => ({ ...call, status: 'failed' })),
    })).toHaveLength(1)
  })
  it('启动回执不能证明完成，真实 completed 状态才能', () => {
    expect(unsupportedWorkflowClaims('已完成第 1 章 generate_draft 工作流。', receipt)).toHaveLength(1)
    expect(unsupportedWorkflowClaims('已完成第 1 章 generate_draft 工作流。', {
      ...receipt, getWorkflowStatus: () => 'completed',
    })).toEqual([])
    expect(unsupportedWorkflowClaims('已完成第 1 章 generate_draft 工作流。', {
      ...receipt, getWorkflowStatus: () => 'failed',
    })).toHaveLength(1)
  })
  it.each(['尚未启动工作流。', '准备启动工作流。', '是否已启动工作流？', '> 已启动工作流。', '```\n已启动工作流。\n```', '工作流启动不等于完成。'])(
    '不拦截否定、计划、问题或引用：%s', text => {
      expect(unsupportedWorkflowClaims(text, { toolCalls: [], artifacts: [] })).toEqual([])
    },
  )
})
