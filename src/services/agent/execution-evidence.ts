import type { ToolCallInfo } from './agent-engine'

export interface ExecutionReceipt {
  turnId: string
  step: number
  callId: string
  toolName: string
  target: string
  outcome: 'committed' | 'failed' | 'unknown'
  verified: boolean
  projectPath?: string
  revision?: number
}

export interface ExecutionOutcome {
  turnId: string
  status: 'completed' | 'partial' | 'unverified' | 'exhausted' | 'cancelled'
  receipts: ExecutionReceipt[]
}

const CONFIG_FIELDS: Record<string, string[]> = {
  globalGuidance: ['全局写作要求', '全局要求', 'globalGuidance'],
  writingStyle: ['写作风格', '文风', 'writingStyle'],
  protagonistProfile: ['主角人设', '主角设定', 'protagonistProfile'],
  goldenFinger: ['金手指', 'goldenFinger'],
  coreOutline: ['核心大纲', 'coreOutline'],
  worldSetting: ['世界观设定', '世界设定', 'worldSetting'],
  genre: ['主类型', 'genre'],
  subGenre: ['子类型', 'subGenre'],
  targetAudience: ['目标读者', 'targetAudience'],
  totalChapters: ['总章节数', 'totalChapters'],
  wordsPerChapter: ['每章字数', 'wordsPerChapter'],
  referenceWorks: ['参考作品', 'referenceWorks'],
  plotStructure: ['情节结构', 'plotStructure'],
  narrativePOV: ['叙事视角', 'narrativePOV'],
}

export function executionTarget(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'update_config') return `config:${String(args.field)}`
  if (toolName === 'start_workflow') return `workflow:${String(args.workflow)}:${String(args.chapter_number ?? '')}:${String(args.chapter_end ?? '')}`
  if (toolName === 'index_content') return `knowledge:${String(args.file_name ?? args.title ?? args.name ?? '')}`
  if (toolName === 'call_external_api') return `external:${String(args.method ?? 'GET')}:${String(args.url ?? args.path ?? '')}`
  return String(args.file_path ?? args.path ?? args.character_name ?? args.name ?? toolName)
}

export const UNVERIFIED_EXECUTION_NOTICE = '本轮修改完成声明未通过执行核验：缺少对应目标的成功写入回执，不能确认已完成。'
export const EXECUTION_DIAGNOSIS = '执行核验未通过。以下修改完成声明缺少本轮对应目标的成功写入回执：\n{claims}\n请先读取实际状态，再执行缺失的操作；不得用历史回复、计划或只读成功冒充写入。如果不需要修改，请依据本轮实际读取结果说明；若无法完成，请明确说明未完成，不要再次宣称已修改。'

export function unsupportedMutationClaims(text: string, calls: readonly ToolCallInfo[]): string[] {
  const visible = text.replace(/```[\s\S]*?```/g, '').replace(/<(?:think|thinking)>[\s\S]*?<\/(?:think|thinking)>/gi, '')
  const latest = new Map<string, ExecutionReceipt>()
  for (const call of calls) {
    if (call.receipt && call.receipt.callId === call.id && call.receipt.turnId === call.turnId) latest.set(call.receipt.target, call.receipt)
  }
  const committed = [...latest.values()].filter(r => r.outcome === 'committed')
  return visible.split(/\n|(?<=[。！？])/u).filter(segment => {
    const plain = segment.replace(/[*`]/g, '').trim()
    if (!plain || /^(?:>|[“"「])/.test(plain)) return false
    if (/(?:未|没有|并未|尚未|无需|不必|不能|不要|不得|不代表|不等于|是否|如果|若|将|准备|计划|需要|可以|建议).{0,16}(?:更新|修改|补充|写入|写进|保存|删除|创建|完成)/.test(plain)) return false
    const claim = /(?:已(?:经)?|成功).{0,24}(?:更新|修改|补充|写入|写进|保存|删除|创建)|(?:写入|写进|补充进|保存到|更新了).{0,30}(?:配置|设定|文件|位置|要求|角色)|(?:配置|设定|文件|要求|修改).{0,16}(?:已完成|完成了|处理完毕)/.test(plain)
      || /\b(?:have|has|successfully|already)\s+(?:\w+\s+){0,3}(?:updated|saved|written|modified|deleted|created)\b/i.test(plain)
    if (!claim || /工作流|workflow|流程/.test(plain)) return false
    const fields = Object.entries(CONFIG_FIELDS).filter(([, aliases]) => aliases.some(alias => plain.includes(alias)))
    if (fields.some(([field]) => !committed.some(r => r.target === `config:${field}` && r.verified))) return true
    const paths = [...plain.matchAll(/(?:[A-Za-z]:[\\/]|\.?\.?\/)?[\w\u4e00-\u9fff./\\-]+\.(?:md|txt|json|ya?ml|csv)\b/g)].map(m => m[0])
    if (paths.some(p => !committed.some(r => r.target.replace(/\\/g, '/').endsWith(p.replace(/\\/g, '/'))))) return true
    const countMatch = plain.match(/([1-9]\d*|[一二三四五六七八九十])\s*个?\s*(?:核心)?(?:位置|字段|文件|配置项)/)
    if (countMatch) {
      const n = Number(countMatch[1]) || '一二三四五六七八九十'.indexOf(countMatch[1]) + 1
      if (committed.length < n) return true
    }
    return committed.length === 0
  })
}

export function removeMutationClaims(text: string, claims: readonly string[]): string {
  let result = text
  for (const claim of claims) result = result.replace(claim, '')
  return result.replace(/\n{3,}/g, '\n\n').trim()
}
