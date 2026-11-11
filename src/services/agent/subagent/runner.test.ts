/**
 * runSubAgent（C 档第二轮 T3）——子 agent 运行体。
 * 契约：空白起步（无父历史）；转录与产物可回收；取消/超时/报错都不静默；
 * 注入父端的结果标 untrusted 并截断，回放给全文。
 */
import { describe, it, expect, vi } from 'vitest'
import { runSubAgent, formatSubAgentResult, formatSubAgentTranscript, type SubAgentDeps } from './runner'
import { SUBAGENT_MAX_MS, SUBAGENT_RESULT_MAX_TOKENS, type SubAgentTask } from './types'
import { estimateTokens } from '../token-budget'
import { t } from '../../../shared/locale'
import { toolRegistry } from '../tool-registry'
import type { LLMGenerateFn } from '../agent-engine'

/**
 * 生成函数的测试形态：**必须显式声明形参类型**——
 * `vi.fn(async () => 'ok')` 的元组长度为 0，随后 mock.calls[0][0] 会触发 TS2493
 * （vitest 不做类型检查，只有 tsc 会拦；本项目既有踩坑）。
 */
type GenFn = (messages: { role: string; content: string }[]) => Promise<string>
/** 带流式回调的形态（I3 清洗用例用） */
type GenFn3 = (messages: { role: string; content: string }[], modelId: string, onChunk?: (chunk: string) => void) => Promise<string>

/** DeepSeek V4.1 原生 DSML 工具调用真实形态（双全角竖线 U+FF5C；开标签 calls> 前有空格） */
const dsmlSample = [
  '<｜｜DSML｜｜ calls>',
  '<｜｜DSML｜｜ invoke name="read_file">',
  '<｜｜DSML｜｜ parameter name="file_path" string="true">a.txt</｜｜DSML｜｜ parameter>',
  '</｜｜DSML｜｜ invoke>',
  '</｜｜DSML｜｜ calls>',
].join('\n')

const task = (over: Partial<SubAgentTask> = {}): SubAgentTask =>
  ({ taskId: 'abc123', description: '查玉佩伏笔', prompt: '查清玉佩伏笔', allowedTools: ['read_drafts'], modelId: 'm', ...over })

/** 显式类型（不用 as never：那会掩盖注入签名的漂移） */
const baseDeps = (over: Partial<SubAgentDeps> = {}): SubAgentDeps => ({
  generate: async () => 'ok',
  buildPrompt: async () => 'SUBPROMPT',
  confirm: async () => true,
  ...over,
})

describe('runSubAgent', () => {
  it('正常完成：结论进 result、转录含 user 提示与 assistant 回复、状态 completed', async () => {
    const generate = vi.fn(async () => '玉佩在第 3 章首次出现。')
    const s = await runSubAgent(task(), baseDeps({ generate }))
    expect(s.status).toBe('completed')
    expect(s.result).toContain('玉佩在第 3 章首次出现。')
    expect(s.messages[0]).toMatchObject({ role: 'user', content: '查清玉佩伏笔' })
    expect(s.messages.some(m => m.role === 'assistant' && m.content.includes('玉佩'))).toBe(true)
    expect(s.endedAt).toBeGreaterThanOrEqual(s.startedAt)
  })

  it('空白起步：systemPrompt 用注入的装配结果，消息里没有父历史', async () => {
    const generate = vi.fn<GenFn>(async () => 'ok')
    await runSubAgent(task(), baseDeps({ generate }))
    const firstCall = generate.mock.calls[0][0]
    expect(firstCall[0]).toMatchObject({ role: 'system', content: 'SUBPROMPT' })
    expect(firstCall.filter(m => m.role !== 'system')).toHaveLength(1)   // 只有本轮 user
  })

  it('generateFn 抛错 → failed + 原因，不向上抛（Review Focus 2）', async () => {
    const generate = vi.fn(async () => { throw new Error('model down') })
    const s = await runSubAgent(task(), baseDeps({ generate }))
    expect(s.status).toBe('failed')
    expect(s.error).toContain('model down')
  })

  it('父 signal 取消 → cancelled，转录保留', async () => {
    const ac = new AbortController()
    const generate = vi.fn(async (_m: unknown, _id: string, onChunk?: (c: string) => void) => {
      ac.abort()                       // 模拟「生成中途被取消」
      onChunk?.('半截')
      return '半截'
    })
    const s = await runSubAgent(task(), baseDeps({ generate: generate as never, signal: ac.signal }))
    expect(s.status).toBe('cancelled')
    expect(s.messages.length).toBeGreaterThan(0)
  })

  it('父 signal 已取消：不装配提示词、不发起生成', async () => {
    const ac = new AbortController()
    ac.abort()
    const buildPrompt = vi.fn(async () => 'SUBPROMPT')
    const generate = vi.fn<LLMGenerateFn>(async () => '不应生成')
    const s = await runSubAgent(task(), baseDeps({ signal: ac.signal, buildPrompt, generate }))
    expect(s.status).toBe('cancelled')
    expect(buildPrompt).not.toHaveBeenCalled()
    expect(generate).not.toHaveBeenCalled()
  })

  it('真实定时器中止挂起生成：及时失败，晚到 chunk 和结果不污染终态', async () => {
    const realTimer = globalThis.setTimeout
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler, delay, ...args) =>
      realTimer(handler, delay === SUBAGENT_MAX_MS ? 20 : delay, ...args))
    let chunk: ((text: string) => void) | undefined
    let generationSignal: AbortSignal | undefined
    let resolve!: (text: string) => void
    const generate = vi.fn<LLMGenerateFn>((_messages, _modelId, onChunk, _onRequestId, signal) => {
      chunk = onChunk
      generationSignal = signal
      expect(signal?.aborted).toBe(false)
      onChunk?.('已生成部分')
      return new Promise<string>(r => { resolve = r })
    })
    const onUpdate = vi.fn()
    const onProgress = vi.fn()
    try {
      const s = await runSubAgent(task(), baseDeps({ generate, onUpdate, onProgress }))
      expect(s.status).toBe('failed')
      expect(s.error).toBe(t('subagent.timeout'))
      expect(generationSignal?.aborted).toBe(true)
      expect(s.messages.some(m => m.content.includes('已生成部分'))).toBe(true)
      expect(s.messages.every(m => !m.streaming)).toBe(true)
      const snapshot = JSON.stringify(s)
      const updates = onUpdate.mock.calls.length
      const progress = onProgress.mock.calls.length
      chunk?.('晚到内容')
      resolve('晚到完整结果')
      await new Promise<void>(r => realTimer(r, 10))
      expect(JSON.stringify(s)).toBe(snapshot)
      expect(onUpdate).toHaveBeenCalledTimes(updates)
      expect(onProgress).toHaveBeenCalledTimes(progress)
    } finally {
      timer.mockRestore()
    }
  })

  it('父取消挂起生成：不等待模型返回，晚到拒绝不改写取消会话', async () => {
    const ac = new AbortController()
    let reject!: (error: Error) => void
    let generationSignal: AbortSignal | undefined
    let started!: () => void
    const generating = new Promise<void>(r => { started = r })
    const generate = vi.fn<LLMGenerateFn>((_messages, _modelId, _onChunk, _onRequestId, signal) => {
      generationSignal = signal
      started()
      return new Promise<string>((_resolve, r) => { reject = r })
    })
    const running = runSubAgent(task(), baseDeps({ generate, signal: ac.signal }))
    await generating
    expect(generationSignal).toBeDefined()
    expect(generationSignal).not.toBe(ac.signal)
    ac.abort()
    const s = await running
    expect(s.status).toBe('cancelled')
    expect(generationSignal?.aborted).toBe(true)
    const snapshot = JSON.stringify(s)
    reject(new Error('晚到网络异常'))
    await new Promise<void>(r => setTimeout(r, 10))
    expect(JSON.stringify(s)).toBe(snapshot)
  })

  it('挂起审批父取消：收到 runner signal、不执行工具，晚到批准不污染转录', async () => {
    const realTimer = globalThis.setTimeout
    const ac = new AbortController()
    let approvalSignal: AbortSignal | undefined
    let approve!: (value: boolean) => void
    let waiting!: () => void
    const pending = new Promise<void>(r => { waiting = r })
    const execute = vi.fn(async () => ({ success: true, content: '不应执行' }))
    const toolName = 'runner_cancel_approval_test'
    toolRegistry.register({
      name: toolName, description: '测试写入审批', source: 'builtin',
      inputSchema: { type: 'object', properties: {} },
      requiresConfirmation: true, isReadOnly: false, execute,
    })
    const confirm = vi.fn<SubAgentDeps['confirm']>((_tc, signal) => {
      approvalSignal = signal
      waiting()
      return new Promise<boolean>(r => { approve = r })
    })
    const generate = vi.fn<LLMGenerateFn>(async () => `<tool_call>{"name":"${toolName}","arguments":{}}</tool_call>`)
    try {
      const running = runSubAgent(task({ allowedTools: [toolName] }), baseDeps({ generate, confirm, signal: ac.signal }))
      await pending
      expect(approvalSignal).toBeDefined()
      expect(approvalSignal).not.toBe(ac.signal)
      ac.abort()
      const s = await running
      expect(s.status).toBe('cancelled')
      expect(s.error).toBe(t('subagent.cancelled'))
      expect(approvalSignal?.aborted).toBe(true)
      expect(s.toolCalls.every(tc => tc.status === 'failed')).toBe(true)
      expect(s.messages.flatMap(m => m.toolCalls ?? []).every(tc => tc.status === 'failed')).toBe(true)
      expect(execute).not.toHaveBeenCalled()
      const snapshot = JSON.stringify(s)
      approve(true)
      await new Promise<void>(r => realTimer(r, 10))
      expect(JSON.stringify(s)).toBe(snapshot)
      expect(execute).not.toHaveBeenCalled()
      expect(generate).toHaveBeenCalledTimes(1)
    } finally {
      toolRegistry.unregister(toolName)
    }
  })

  it('人工审批超过5分钟不耗执行预算，并暂停和恢复父task计时', async () => {
    const name = 'runner_long_approval'
    let clock = 0
    const resumeParent = vi.fn()
    const pauseExecutionTimeout = vi.fn(() => resumeParent)
    toolRegistry.register({ name, description: 'approval', source: 'builtin',
      inputSchema: { type: 'object', properties: {} }, requiresConfirmation: true, isReadOnly: false,
      execute: async () => ({ success: true, content: 'written' }),
    })
    const generate = vi.fn<LLMGenerateFn>()
      .mockResolvedValueOnce(`<tool_call>{"name":"${name}","arguments":{}}</tool_call>`)
      .mockResolvedValueOnce('done')
    try {
      const session = await runSubAgent(task({ allowedTools: [name] }), baseDeps({ generate,
        now: () => clock, pauseExecutionTimeout,
        confirm: async () => { clock += 1800000; return true },
      }))
      expect(session.status).toBe('completed')
      expect(pauseExecutionTimeout).toHaveBeenCalledOnce()
      expect(resumeParent).toHaveBeenCalledOnce()
    } finally { toolRegistry.unregister(name) }
  })

  it('墙钟超时 → failed + 超时原因（用注入的 now 驱动，测试不等待真实时间）', async () => {
    let clock = 0
    const generate = vi.fn(async () => { clock += SUBAGENT_MAX_MS + 1; return 'ok' })
    const s = await runSubAgent(task(), baseDeps({ generate, now: () => clock }))
    expect(s.status).toBe('failed')
    expect(s.error).toBe(t('subagent.timeout'))
  })

  it.each(['false', 'reject'] as const)('子执行前归档屏障 %s：写入零执行，session 与工具转录均为失败终态', async mode => {
    const name = `runner_barrier_${mode}`
    const execute = vi.fn(async () => ({ success: true, content: '不应写入' }))
    toolRegistry.register({
      name, description: 'child archive barrier write', source: 'builtin',
      inputSchema: { type: 'object', properties: {} }, isReadOnly: false,
      requiresConfirmation: false, execute,
    })
    const snapshots: string[] = []
    const beforeExecute = vi.fn<NonNullable<SubAgentDeps['beforeExecute']>>(async session => {
      expect(session.toolCalls).toEqual([expect.objectContaining({ toolName: name, status: 'running' })])
      if (mode === 'reject') throw new Error('child archive unavailable')
      return false
    })
    const generate = vi.fn<LLMGenerateFn>()
      .mockResolvedValueOnce(`<tool_call>{"name":"${name}","arguments":{}}</tool_call>`)
      .mockResolvedValueOnce('写入失败，未执行。')
    try {
      const s = await runSubAgent(task({ allowedTools: [name] }), baseDeps({
        generate, beforeExecute, onUpdate: session => snapshots.push(JSON.stringify(session)),
      }))
      expect(beforeExecute).toHaveBeenCalledOnce()
      expect(execute).not.toHaveBeenCalled()
      expect(s.status).toBe('failed')
      expect(s.error).toBeTruthy()
      expect(s.toolCalls).toEqual([expect.objectContaining({ status: 'failed', receipt: expect.objectContaining({ outcome: 'failed', verified: false }) })])
      expect(s.messages.flatMap(m => m.toolCalls ?? [])).toEqual(s.toolCalls)
      expect(s.messages.every(m => !m.streaming)).toBe(true)
      expect(JSON.parse(snapshots.at(-1)!).status).toBe('failed')
    } finally { toolRegistry.unregister(name) }
  })

  it('子屏障挂起期间父取消：晚到归档成功不能执行写入或污染取消终态', async () => {
    const name = 'runner_cancel_barrier'
    const controller = new AbortController()
    const execute = vi.fn(async () => ({ success: true, content: '不应写入' }))
    toolRegistry.register({
      name, description: 'child cancellable archive barrier', source: 'builtin',
      inputSchema: { type: 'object', properties: {} }, isReadOnly: false,
      requiresConfirmation: false, execute,
    })
    let release!: (saved: boolean) => void
    const beforeExecute = vi.fn<NonNullable<SubAgentDeps['beforeExecute']>>(() => new Promise(resolve => { release = resolve }))
    const onUpdate = vi.fn()
    const generate = vi.fn<LLMGenerateFn>().mockResolvedValue(`<tool_call>{"name":"${name}","arguments":{}}</tool_call>`)
    try {
      const running = runSubAgent(task({ allowedTools: [name] }), baseDeps({ generate, beforeExecute, signal: controller.signal, onUpdate }))
      await vi.waitFor(() => expect(beforeExecute).toHaveBeenCalledOnce())
      controller.abort()
      const s = await running
      expect(s.status).toBe('cancelled')
      expect(s.toolCalls.every(tc => tc.status === 'failed')).toBe(true)
      expect(execute).not.toHaveBeenCalled()
      const snapshot = JSON.stringify(s)
      const updates = onUpdate.mock.calls.length
      release(true)
      await Promise.resolve()
      expect(JSON.stringify(s)).toBe(snapshot)
      expect(onUpdate).toHaveBeenCalledTimes(updates)
      expect(execute).not.toHaveBeenCalled()
    } finally { toolRegistry.unregister(name) }
  })

  it('工具调用进转录（toolCalls 与 assistant 消息同源）', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce('<tool_call>{"name":"read_drafts","arguments":{"chapter":3}}</tool_call>')
      .mockResolvedValueOnce('结论：玉佩在第 3 章。')
    const s = await runSubAgent(task(), baseDeps({ generate }))
    expect(s.toolCalls.map(c => c.toolName)).toContain('read_drafts')
    expect(s.messages.some(m => (m.toolCalls ?? []).some(tc => tc.toolName === 'read_drafts'))).toBe(true)
  })

  it('onUpdate 被调用，且最后一次是终态（父端据此流式写回 store）', async () => {
    const generate = vi.fn(async () => 'ok')
    const onUpdate = vi.fn()
    await runSubAgent(task(), baseDeps({ generate, onUpdate }))
    expect(onUpdate).toHaveBeenCalled()
    const last = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0] as { status: string }
    expect(last.status).toBe('completed')
  })

  it('转录消息数不超上限（MAX_SUBAGENT_MESSAGES）', async () => {
    const many = Array.from({ length: 80 }, (_, i) => `<tool_call>{"name":"read_drafts","arguments":{"chapter":${i}}}</tool_call>`)
    const generate = vi.fn<GenFn>(async (messages) => {
      const idx = messages.filter(m => m.content.includes('<tool_result')).length
      return many[idx] ?? '结论'
    })
    const s = await runSubAgent(task(), baseDeps({ generate }))
    expect(s.messages.length).toBeLessThanOrEqual(60)
  })
})

describe('formatSubAgentResult（untrusted 回收）', () => {
  const mk = (result: string, over = {}) => ({
    id: 'abc123', taskId: 'abc123', description: '查玉佩伏笔', prompt: '', allowedTools: [],
    status: 'completed' as const, messages: [], toolCalls: [], artifacts: [], result, startedAt: 0, endedAt: 1000, ...over,
  })

  it('含 untrusted 标注 + task_id + 回放提示', () => {
    const text = formatSubAgentResult(mk('结论'))
    expect(text).toContain('结论')
    expect(text).toContain('untrusted')
    expect(text).toContain('abc123')
    expect(text).toMatch(/task\(/)
  })

  it('超 1200 tokens 截断（头部/尾部标注另计，故断言留余量）', () => {
    const text = formatSubAgentResult(mk('详'.repeat(3000)))
    expect(estimateTokens(text)).toBeLessThanOrEqual(SUBAGENT_RESULT_MAX_TOKENS + 200)
  })

  it('失败不静默：状态与原因都在文本里（Review Focus 2）', () => {
    const text = formatSubAgentResult(mk('', { status: 'failed', error: 'model down' }))
    expect(text).toContain('model down')
  })

  it('空结论给显式空态（不是空白）', () => {
    expect(formatSubAgentResult(mk(''))).toContain(t('subagent.emptyResult'))
  })
})

describe('formatSubAgentTranscript（task(task_id) 回放）', () => {
  it('给全文转录 + 同样标 untrusted（截断只作用于「回收」，不作用于回放）', () => {
    const long = {
      id: 'abc123', taskId: 'abc123', description: '查玉佩伏笔', prompt: '', allowedTools: [],
      status: 'completed' as const, toolCalls: [], artifacts: [], result: '详'.repeat(3000),
      messages: [
        { id: 'm1', role: 'user' as const, content: '查玉佩', createdAt: 0 },
        { id: 'm2', role: 'assistant' as const, content: '详'.repeat(3000), createdAt: 1 },
      ],
      startedAt: 0, endedAt: 1,
    }
    const text = formatSubAgentTranscript(long)
    expect(text).toContain('untrusted')
    expect(text.length).toBeGreaterThan(3000)     // 未被截断
    expect(text).toContain('查玉佩')
  })

  it('失败的子会话回放也带原因', () => {
    const s = {
      id: 'x', taskId: 'x', description: 'd', prompt: '', allowedTools: [], status: 'failed' as const,
      messages: [], toolCalls: [], artifacts: [], result: '', error: 'model down', startedAt: 0, endedAt: 1,
    }
    expect(formatSubAgentTranscript(s)).toContain('model down')
  })
})

describe('评审修复：写入侧净化与产物合并（C 档第二轮）', () => {
  it('I3：流式 chunk 里的 tool_call/tool_result 标签被清洗（父同口径，否则卡片给用户看 JSON）', async () => {
    const generate = vi.fn<GenFn3>(async (_m, _id, onChunk) => {
      onChunk?.('<tool_call>{"name":"read_drafts","arguments":{"chapter":3}}</tool_call>')
      onChunk?.('玉佩在第 3 章。')
      return '<tool_call>{"name":"read_drafts","arguments":{"chapter":3}}</tool_call>\n玉佩在第 3 章。'
    })
    const s = await runSubAgent(task(), baseDeps({ generate: generate as never }))
    const all = s.messages.map(m => m.content).join('\n')
    expect(all).not.toContain('<tool_call>')
    expect(all).toContain('玉佩在第 3 章。')
  })

  it('I3：onDone 用清洗后的全文重写（跨 chunk 被切开的标签也能清掉）', async () => {
    const generate = vi.fn<GenFn3>(async (_m, _id, onChunk) => {
      onChunk?.('<tool_')            // 半截
      onChunk?.('call>{"name":"x","arguments":{}}</tool_call>')
      return '结论：玉佩在第 3 章。<tool_call>{"name":"x","arguments":{}}</tool_call>'
    })
    const s = await runSubAgent(task(), baseDeps({ generate: generate as never }))
    expect(s.result).not.toContain('<tool_call>')
    expect(s.messages.map(m => m.content).join('\n')).not.toContain('<tool_call>')
  })
})

// 2026-10-17（DeepSeek V4.1 DSML 文本泄漏）：子 agent 转录会回放给父，DSML 原文不得进入转录/result
describe('DSML 原生工具标记清洗（2026-10-17 泄漏样本）', () => {
  it('onChunk 传入含完整 DSML 块的文本 → 流式转录中任何快照都不含 DSML', async () => {
    const snapshots: string[] = []
    const generate = vi.fn<GenFn3>(async (_m, _id, onChunk) => {
      onChunk?.(dsmlSample)
      onChunk?.('玉佩在第 3 章。')
      return '玉佩在第 3 章。'
    })
    const s = await runSubAgent(task(), baseDeps({
      generate: generate as never,
      // 深拷贝成字符串快照：onUpdate 传的是可变 session 引用，留引用会被后续改写掩盖
      onUpdate: snap => snapshots.push(snap.messages.map(m => m.content).join('\n')),
    }))
    expect(snapshots.length).toBeGreaterThan(0)
    expect(snapshots.every(t => !t.includes('DSML'))).toBe(true)
    expect(s.messages.map(m => m.content).join('\n')).not.toContain('DSML')
  })

  it('onDone 全文含 DSML → session.result 与最后一条 assistant content 已清洗', async () => {
    const generate = vi.fn<GenFn3>(async () => `先读文件。\n${dsmlSample}`)
    const s = await runSubAgent(task(), baseDeps({ generate: generate as never }))
    expect(s.result).not.toContain('DSML')
    expect(s.result).not.toContain('｜')
    expect(s.result).toContain('先读文件。')
    const last = s.messages[s.messages.length - 1]!
    expect(last.role).toBe('assistant')
    expect(last.content).not.toContain('DSML')
    expect(last.content).toContain('先读文件。')
  })
})
