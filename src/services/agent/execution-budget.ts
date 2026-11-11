export interface AgentExecutionPrefs {
  maxTaskSteps: number
}

export const DEFAULT_AGENT_EXECUTION_PREFS: AgentExecutionPrefs = { maxTaskSteps: 100 }
export const MIN_TASK_STEPS = 16
export const MAX_TASK_STEPS = 1000

export function resolveAgentExecutionPrefs(config?: { agentExecution?: unknown } | null): AgentExecutionPrefs {
  const raw = config?.agentExecution
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).maxTaskSteps : undefined
  return {
    maxTaskSteps: typeof value === 'number' && Number.isFinite(value)
      ? Math.min(MAX_TASK_STEPS, Math.max(MIN_TASK_STEPS, Math.round(value)))
      : DEFAULT_AGENT_EXECUTION_PREFS.maxTaskSteps,
  }
}

/** 一次用户任务的共享模型请求预算；恢复重试及委派均不重置。 */
export class AgentTaskBudget {
  used = 0
  constructor(readonly maxSteps = DEFAULT_AGENT_EXECUTION_PREFS.maxTaskSteps) {
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) throw new Error('Invalid agent task budget')
  }
  get remaining(): number { return Math.max(0, this.maxSteps - this.used) }
  consume(): boolean {
    if (this.remaining === 0) return false
    this.used++
    return true
  }
}

export function stableExecutionValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableExecutionValue).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableExecutionValue(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

/** 保留完整结果差异，不让上下文截断把变化中的结果误判为重复。 */
export function executionResultKey(value: unknown): string {
  const text = stableExecutionValue(value)
  let hash = 2166136261
  let second = 5381
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
    second = Math.imul(second, 33) ^ text.charCodeAt(i)
  }
  return `${text.length}:${hash >>> 0}:${second >>> 0}`
}

/** 同结果重复或短周期循环：先给一次策略调整机会，仍无新证据才停止。 */
export class NoProgressGuard {
  private seen = new Set<string>()
  private repeats = 0
  private nudged = false

  observe(keys: string[]): 'continue' | 'adjust' | 'stop' {
    const fresh = keys.some(key => !this.seen.has(key))
    keys.forEach(key => this.seen.add(key))
    if (fresh) {
      this.repeats = 0
      this.nudged = false
      return 'continue'
    }
    this.repeats++
    if (this.repeats < 3) return 'continue'
    if (!this.nudged) {
      this.nudged = true
      return 'adjust'
    }
    return 'stop'
  }
}
