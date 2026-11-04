import type { ToolCallInfo } from './agent-engine'
import type { ToolArtifact } from './tool-registry'

export interface WorkflowClaimEvidence {
  toolCalls: readonly ToolCallInfo[]
  artifacts: readonly ToolArtifact[]
  getWorkflowStatus?: (runId: string) => string | undefined
}

const WORKFLOW_NAMES = ['generate_book', 'generate_draft', 'review', 'refine', 'finalize', 'generate_blueprint', 'generate_architecture', 'config_generation']

export function unsupportedWorkflowClaims(text: string, evidence: WorkflowClaimEvidence): string[] {
  const visible = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<(?:think|thinking)>[\s\S]*?<\/(?:think|thinking)>/gi, '')
  return visible.split(/\n|(?<=[。！？])/u).filter(segment => {
    const plain = segment.replace(/[*`]/g, '').trim()
    if (!plain || /^(?:>|[“"「])/.test(plain)) return false
    if (/(?:未|没有|并未|尚未|不能|不要|不得|不代表|不等于|是否|如果|若|将|准备|计划|需要|可以|建议).{0,12}(?:启动|触发|发起|完成|执行|运行)/.test(plain)) return false
    const completed = /(?:已(?:经)?|成功).{0,12}(?:完成|执行完|生成完)|(?:工作流|流程).{0,20}(?:全部搞定|完成了|执行完毕)/.test(plain)
    const started = /(?:已(?:经)?|成功|为你|帮你).{0,16}(?:启动|触发|发起|运行|执行)/.test(plain)
    if (!completed && !started) return false
    if (!/工作流|流程|generate_(?:draft|blueprint|architecture|book)|config_generation/.test(plain)) return false
    const workflow = WORKFLOW_NAMES.find(name => new RegExp(`\\b${name}\\b`).test(plain))
    const chapter = plain.match(/第\s*(\d+)\s*章/)
    const receipts = evidence.toolCalls.filter(call => {
      if (call.toolName !== 'start_workflow' || call.status !== 'completed') return false
      if (workflow && call.arguments.workflow !== workflow) return false
      if (chapter) {
        const start = Number(call.arguments.chapter_number)
        const end = Number(call.arguments.chapter_end ?? start)
        if (Number(chapter[1]) < start || Number(chapter[1]) > end || !Number.isFinite(start)) return false
      }
      return true
    })
    if (receipts.length === 0) return true
    if (!completed) return false
    const runs = evidence.artifacts.filter(a => a.type === 'workflow_started'
      && typeof a.metadata?.runId === 'string'
      && (!workflow || a.metadata.workflow === workflow)
      && (!chapter || a.metadata.chapterNumber === Number(chapter[1])))
    return runs.length === 0 || runs.some(a => evidence.getWorkflowStatus?.(a.metadata!.runId as string) !== 'completed')
  })
}

export function removeUnsupportedWorkflowClaims(text: string, claims: readonly string[]): string {
  let cleaned = text
  for (const claim of claims) cleaned = cleaned.replace(claim, '')
  return cleaned.replace(/\n{3,}/g, '\n\n').trim()
}
