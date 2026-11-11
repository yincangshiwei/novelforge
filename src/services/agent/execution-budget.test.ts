import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentTaskBudget, NoProgressGuard, executionResultKey, resolveAgentExecutionPrefs } from './execution-budget'
import { runAgentLoop, type LLMMessage } from './agent-engine'
import { buildAgentTool, toolRegistry } from './tool-registry'
import { runSubAgent } from './subagent/runner'
import { ProgressTracker } from './progress-tracker'
import { t } from '../../shared/locale'

const name = 'budget_test_tool'
const call = (index = 0) => `<tool_call>${JSON.stringify({ name, arguments: { index } })}</tool_call>`
const callbacks = () => ({
  onTextChunk: vi.fn(), onToolCallStart: vi.fn(), onToolCallComplete: vi.fn(),
  onToolCallConfirmRequired: vi.fn(async () => true), onProgress: vi.fn(), onDone: vi.fn(), onError: vi.fn(),
})
function register(content: () => string = () => 'ok') {
  toolRegistry.register(buildAgentTool({
    name, description: 'budget test', source: 'builtin', isReadOnly: true,
    requiresConfirmation: false, inputSchema: { type: 'object', properties: { index: { type: 'number', description: 'index' } } },
    execute: async () => ({ success: true, content: content() }),
  }))
}
afterEach(() => toolRegistry.unregister(name))

async function run(responses: string[], budget?: AgentTaskBudget) {
  const cb = callbacks()
  const generate = vi.fn(async () => responses.shift() ?? 'done')
  await runAgentLoop('system', [], 'task', 'model', generate, cb, undefined, { taskBudget: budget })
  return { cb, generate }
}

describe('任务级连续执行', () => {
  it('正常进展超过8步不打断，最终步数保留真实值', async () => {
    register()
    const { cb, generate } = await run([...Array.from({ length: 12 }, (_, i) => call(i)), 'done'])
    expect(generate).toHaveBeenCalledTimes(13)
    expect(cb.onDone).toHaveBeenCalledWith('done', expect.any(Array), expect.any(Array), expect.objectContaining({
      status: 'completed', stepsUsed: 13, stepBudget: 100, stopReason: undefined,
    }))
    expect(cb.onProgress.mock.calls.at(-1)?.[0]).toMatchObject({ completedSteps: 13, totalSteps: 100 })
  })

  it('最后一份预算恰好返回答案，不误报耗尽', async () => {
    const { cb } = await run(['done'], new AgentTaskBudget(1))
    expect(cb.onDone.mock.calls[0][3]).toMatchObject({ status: 'completed', stepsUsed: 1 })
  })

  it('预算耗尽不自动续出新额度，明确展示记录且不回滚', async () => {
    register()
    const budget = new AgentTaskBudget(3)
    const { cb, generate } = await run([call(1), call(2), call(3), 'done'], budget)
    expect(generate).toHaveBeenCalledTimes(3)
    expect(cb.onDone.mock.calls[0][3]).toMatchObject({ status: 'exhausted', stopReason: 'budget_exhausted', stepsUsed: 3 })
    expect(cb.onDone.mock.calls[0][0]).toContain('工具成功 3 次')
    expect(cb.onDone.mock.calls[0][0]).not.toContain('再发一条消息让我继续')
    const next = await run(['done'], budget)
    expect(next.generate).not.toHaveBeenCalled()
  })

  it('相同输入结果先提醒调整，仍重复才停止', async () => {
    register()
    const cb = callbacks()
    const generate = vi.fn(async (messages: LLMMessage[]) => {
      if (generate.mock.calls.length === 5) expect(messages.at(-1)?.content).toBe(t('agent.noProgressAdjust'))
      return call()
    })
    await runAgentLoop('system', [], 'task', 'model', generate, cb)
    expect(generate).toHaveBeenCalledTimes(5)
    expect(cb.onDone.mock.calls[0][3]).toMatchObject({ status: 'exhausted', stopReason: 'no_progress' })
  })

  it('策略调整带来新结果后可继续完成', async () => {
    register()
    const { cb, generate } = await run([call(), call(), call(), call(), call(1), 'done'])
    expect(generate).toHaveBeenCalledTimes(6)
    expect(cb.onDone.mock.calls[0][3]).toMatchObject({ status: 'completed' })
  })

  it('同参数但长结果尾部变化不被截断误杀', async () => {
    let revision = 0
    register(() => 'a'.repeat(10000) + revision++)
    const { cb, generate } = await run([...Array.from({ length: 10 }, () => call()), 'done'])
    expect(generate).toHaveBeenCalledTimes(11)
    expect(cb.onDone.mock.calls[0][3]).toMatchObject({ status: 'completed' })
  })

  it('重复解析错误受无进展保护，不烧完整预算', async () => {
    const { cb, generate } = await run(Array(20).fill('<tool_call>not JSON</tool_call>'))
    expect(generate).toHaveBeenCalledTimes(5)
    expect(cb.onDone.mock.calls[0][3]).toMatchObject({ stopReason: 'no_progress' })
  })

  it('恢复重试消耗同一预算，最后请求真实错误不吞掉', async () => {
    const budget = new AgentTaskBudget(2)
    const generate = vi.fn(async () => { throw new Error('maximum context length exceeded') })
    const cb = callbacks()
    await runAgentLoop('system', [], 'task', 'model', generate, cb, undefined, { taskBudget: budget })
    expect(generate).toHaveBeenCalledTimes(2)
    expect(budget.used).toBe(2)
    expect(cb.onError).toHaveBeenCalledOnce()
    expect(cb.onDone).not.toHaveBeenCalled()
  })

  it('父与委派共享预算，委派不重置计数', async () => {
    register()
    const budget = new AgentTaskBudget(3)
    const cb = callbacks()
    const childGenerate = vi.fn(async () => call())
    const parentGenerate = vi.fn(async () => {
      const session = await runSubAgent({ taskId: 'budget-child', description: 'child', prompt: 'task', allowedTools: [name], modelId: 'model' }, {
        generate: childGenerate, buildPrompt: async () => 'system', confirm: async () => true, taskBudget: budget,
      })
      expect(session.executionOutcome).toMatchObject({ stopReason: 'budget_exhausted', stepsUsed: 3 })
      return call(99)
    })
    await runAgentLoop('system', [], 'task', 'model', parentGenerate, cb, undefined, { taskBudget: budget })
    expect(parentGenerate).toHaveBeenCalledOnce()
    expect(childGenerate).toHaveBeenCalledTimes(2)
    expect(budget.used).toBe(3)
    expect(cb.onDone.mock.calls[0][3]).toMatchObject({ stopReason: 'budget_exhausted' })
  })

  it('已取消时不消费预算也不请求模型', async () => {
    const controller = new AbortController()
    controller.abort()
    const budget = new AgentTaskBudget(3)
    const cb = callbacks()
    const generate = vi.fn(async () => 'done')
    await runAgentLoop('system', [], 'task', 'model', generate, cb, controller.signal, { taskBudget: budget })
    expect(generate).not.toHaveBeenCalled()
    expect(budget.used).toBe(0)
    expect(cb.onDone.mock.calls[0][3]).toMatchObject({ status: 'cancelled' })
  })
})

describe('预算与重复检测基础边界', () => {
  it('旧配置及非法值回默认，有限值钳制到安全范围', () => {
    expect(resolveAgentExecutionPrefs()).toEqual({ maxTaskSteps: 100 })
    expect(resolveAgentExecutionPrefs({ agentExecution: { maxTaskSteps: Infinity } })).toEqual({ maxTaskSteps: 100 })
    expect(resolveAgentExecutionPrefs({ agentExecution: { maxTaskSteps: 8 } })).toEqual({ maxTaskSteps: 16 })
    expect(resolveAgentExecutionPrefs({ agentExecution: { maxTaskSteps: 99999 } })).toEqual({ maxTaskSteps: 1000 })
  })

  it('短周期循环也受保护，新证据恢复检测窗口', () => {
    const guard = new NoProgressGuard()
    expect(guard.observe(['a'])).toBe('continue')
    expect(guard.observe(['b'])).toBe('continue')
    expect(guard.observe(['a'])).toBe('continue')
    expect(guard.observe(['b'])).toBe('continue')
    expect(guard.observe(['a'])).toBe('adjust')
    expect(guard.observe(['b'])).toBe('stop')
    expect(guard.observe(['c'])).toBe('continue')
  })

  it('对象键顺序不影响指纹，结果变化影响指纹', () => {
    expect(executionResultKey({ a: 1, b: 2 })).toBe(executionResultKey({ b: 2, a: 1 }))
    expect(executionResultKey('a')).not.toBe(executionResultKey('b'))
  })

  it('完成追踪不把预算当作已完成工作量', () => {
    const progress = new ProgressTracker()
    progress.start(100)
    progress.stepCompleted()
    progress.complete()
    expect(progress.getProgress()).toMatchObject({ phase: 'done', completedSteps: 1, totalSteps: 100 })
  })
})
