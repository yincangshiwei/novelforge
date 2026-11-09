// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentStore, type AgentConversation } from './agent-store'
import { useProjectStore } from './project-store'
import { useLLMStore } from './llm-store'
import { runAgentLoop, type AgentEngineCallbacks, type ToolCallInfo } from '../services/agent/agent-engine'
import { runSubAgent } from '../services/agent/subagent/runner'
import type { SubAgentSession } from '../services/agent/subagent/types'
import { loadApprovalRules } from '../services/agent/approval'
import { parseArchive } from '../services/agent/archive-codec'
import { toast } from '../components/ui/Toast'
import { buildAgentSystemPromptAsync } from '../services/agent/context-builder'
import { toolRegistry, buildAgentTool } from '../services/agent/tool-registry'
import { detectWritingIntent } from '../services/agent/writing-intent'
import { retrieveContextForQuery } from '../services/agent/rag-context-provider'
import { ipc } from '../services/ipc-client'

vi.mock('../services/agent/agent-engine', async importOriginal => ({
  ...await importOriginal<typeof import('../services/agent/agent-engine')>(),
  runAgentLoop: vi.fn(),
}))
vi.mock('../services/agent/subagent/runner', async importOriginal => ({
  ...await importOriginal<typeof import('../services/agent/subagent/runner')>(),
  runSubAgent: vi.fn(),
}))
vi.mock('../services/agent/approval', async importOriginal => ({
  ...await importOriginal<typeof import('../services/agent/approval')>(),
  loadApprovalRules: vi.fn(async () => []),
}))
vi.mock('../services/agent/writing-intent', () => ({ detectWritingIntent: vi.fn(() => ({ kind: 'none' })) }))
vi.mock('../services/agent/context-builder', () => ({ buildAgentSystemPromptAsync: vi.fn(async () => 'system') }))
vi.mock('../services/agent/rag-context-provider', () => ({
  retrieveContextForQuery: vi.fn(async () => null), DEFAULT_RAG_CONFIG: {}, getRAGSummary: vi.fn(),
}))
vi.mock('../services/render-logger', () => ({ renderLog: vi.fn() }))
vi.mock('../components/ui/Toast', () => ({ toast: { error: vi.fn() } }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const archiveFiles = new Map<string, string>()
let archiveWrite: (id: string, snapshot: string) => Promise<{ success: boolean }>
const mockInvoke = vi.fn(async (channel: string, ...args: unknown[]) => {
  if (channel === 'fs:agent-archive-write') return archiveWrite(String(args[0]), String(args[1]))
  if (channel === 'fs:agent-archive-list') return [...archiveFiles.keys()].map(id => ({ id, title: 'P2', updatedAt: 0 }))
  if (channel === 'fs:agent-archive-read') return archiveFiles.get(String(args[0])) ?? null
  return null
})
const engineMock = vi.mocked(runAgentLoop)
const runnerMock = vi.mocked(runSubAgent)
const rulesMock = vi.mocked(loadApprovalRules)

function seed(): AgentConversation {
  const conv: AgentConversation = {
    id: crypto.randomUUID(), title: 'P2', messages: [], createdAt: 0, updatedAt: 0,
    projectPath: '/mock/proj', modelId: 'm',
  }
  useAgentStore.setState({ conversations: [conv], activeConversationId: conv.id })
  return conv
}

const writeCall = (id = 'write-p2'): ToolCallInfo => ({
  id, toolName: 'write_file', arguments: { file_path: 'drafts/c1.md', content: '正文' }, status: 'running',
})
const session = (taskId: string, status: SubAgentSession['status']): SubAgentSession => ({
  id: taskId, taskId, description: 'P2 子任务', prompt: 'P2 子任务', allowedTools: [],
  status, messages: [], toolCalls: [], artifacts: [], result: '', startedAt: 0, endedAt: 1,
})

beforeEach(async () => {
  archiveWrite = async (id, snapshot) => { archiveFiles.set(id, snapshot); return { success: true } }
  Object.defineProperty(window, 'velaAPI', { value: { invoke: mockInvoke }, configurable: true })
  await useAgentStore.getState().flushArchives()
  vi.clearAllMocks()
  engineMock.mockReset()
  runnerMock.mockReset()
  rulesMock.mockReset().mockResolvedValue([])
  useAgentStore.setState({
    conversations: [], activeConversationId: null, generating: false, activeRequestId: null,
    pendingSubAgentConfirmation: null, archiveSaveStates: {}, toolsInitialized: true,
  })
  useProjectStore.setState({ currentProject: { path: '/mock/proj' } as never, loading: false })
  useLLMStore.setState({ defaultModelId: 'm', models: [], modelRoutes: { elite: [], standard: [], budget: [], strategy: 'static' } })
  archiveFiles.clear()
})

afterEach(async () => {
  archiveWrite = async (id, snapshot) => { archiveFiles.set(id, snapshot); return { success: true } }
  await useAgentStore.getState().prepareForClose()
  vi.restoreAllMocks()
})

describe('P2：父审批读取规则期间取消', () => {
  it('预路由等待期间关闭，晚到返回不追加生成消息或启动引擎', async () => {
    vi.mocked(detectWritingIntent).mockReturnValueOnce({ kind: 'character', action: 'create', name: '合成角色' })
    const routed = deferred<Awaited<ReturnType<ReturnType<typeof useAgentStore.getState>['handleWritingIntent']>>>()
    vi.spyOn(useAgentStore.getState(), 'handleWritingIntent').mockReturnValueOnce(routed.promise)
    const conv = seed()
    const sending = useAgentStore.getState().sendMessage('合成角色预路由')
    const closing = useAgentStore.getState().prepareForClose()
    await expect(closing).resolves.toBe(true)
    await sending
    routed.resolve({ status: 'none', enhancedContent: '晚到增强' })
    await Promise.resolve()
    expect(useAgentStore.getState().conversations.find(c => c.id === conv.id)!.messages).toHaveLength(0)
    expect(engineMock).not.toHaveBeenCalled()
    expect(useAgentStore.getState().generating).toBe(false)
  })
  it('RAG 取消不继续预取或启动引擎', async () => {
    const rag = deferred<Awaited<ReturnType<typeof retrieveContextForQuery>>>()
    vi.mocked(retrieveContextForQuery).mockReturnValueOnce(rag.promise)
    seed()
    const sending = useAgentStore.getState().sendMessage('核对 @架构')
    await vi.waitFor(() => expect(retrieveContextForQuery).toHaveBeenCalled())
    await useAgentStore.getState().cancelGeneration()
    await sending
    expect(engineMock).not.toHaveBeenCalled()
    rag.resolve(null)
  })
  it('提示词准备期间取消，晚到准备结果不启动引擎', async () => {
    const preparing = deferred<string>()
    vi.mocked(buildAgentSystemPromptAsync).mockReturnValueOnce(preparing.promise)
    seed()
    const sending = useAgentStore.getState().sendMessage('准备期间取消')
    await vi.waitFor(() => expect(buildAgentSystemPromptAsync).toHaveBeenCalled())
    await useAgentStore.getState().cancelGeneration()
    preparing.resolve('late system')
    await sending
    expect(engineMock).not.toHaveBeenCalled()
    expect(useAgentStore.getState().generating).toBe(false)
  })
  it('规则读取未返回即可取消并结束父循环；规则晚到不挂审批卡', async () => {
    const rules = deferred<Awaited<ReturnType<typeof loadApprovalRules>>>()
    rulesMock.mockReturnValue(rules.promise)
    let approval!: Promise<boolean>
    let callbacks!: AgentEngineCallbacks
    let rejected: unknown
    engineMock.mockImplementation(async (_sys, _hist, _user, _model, _generate, cb) => {
      callbacks = cb
      cb.onToolCallStart(writeCall())
      approval = cb.onToolCallConfirmRequired(writeCall())
      try { await approval } catch (error) { rejected = error }
    })
    seed()
    const sending = useAgentStore.getState().sendMessage('执行写入')
    await vi.waitFor(() => expect(rulesMock).toHaveBeenCalledOnce())
    await useAgentStore.getState().cancelGeneration()
    await sending
    expect(rejected).toBeInstanceOf(Error)
    expect(String(rejected)).toContain('取消')
    expect(useAgentStore.getState().generating).toBe(false)
    rules.resolve([])
    await Promise.resolve()
    expect(useAgentStore.getState().getActiveConversation()!.messages.flatMap(m => m.toolCalls ?? [])
      .some(call => call.status === 'waiting_confirm')).toBe(false)
    useAgentStore.getState().resolveToolConfirmation('write-p2', true)
    await expect(approval).rejects.toThrow('取消')
    expect(callbacks).toBeDefined()
  })
})

describe('P2：底层请求 ID 晚到的取消补偿', () => {
  it('旧轮次执行终态只更新原消息，不覆盖新轮次状态', async () => {
    const first = deferred<void>(), second = deferred<void>()
    const callbacks: AgentEngineCallbacks[] = []
    engineMock.mockImplementation(async (_s, _h, _u, _m, _g, cb) => {
      callbacks.push(cb)
      await (callbacks.length === 1 ? first.promise : second.promise)
    })
    seed()
    const a = useAgentStore.getState().sendMessage('第一轮')
    await vi.waitFor(() => expect(callbacks).toHaveLength(1))
    await useAgentStore.getState().cancelGeneration()
    const b = useAgentStore.getState().sendMessage('第二轮')
    await vi.waitFor(() => expect(callbacks).toHaveLength(2))
    callbacks[0].onToolCallComplete({ ...writeCall('old'), status: 'completed', result: '已提交' })
    expect(useAgentStore.getState().generating).toBe(true)
    const messages = useAgentStore.getState().getActiveConversation()!.messages
    expect(messages[1].toolCalls?.[0].id).toBe('old')
    expect(messages.at(-1)!.toolCalls ?? []).toHaveLength(0)
    first.resolve(); second.resolve(); await Promise.all([a, b])
  })
  it('父流式请求 ID 在 cancelGeneration 返回后才到，也发送底层取消', async () => {
    const request = deferred<string>()
    const streamSpy = vi.spyOn(useLLMStore.getState(), 'generateStream').mockReturnValue(request.promise)
    const cancelSpy = vi.spyOn(useLLMStore.getState(), 'cancelGeneration').mockResolvedValue(undefined)
    engineMock.mockImplementation(async (_sys, _hist, _user, model, generate) => {
      try { await generate([{ role: 'user', content: '测试' }], model) } catch { /* 引擎消费取消 */ }
    })
    seed()
    const sending = useAgentStore.getState().sendMessage('查询')
    await vi.waitFor(() => expect(streamSpy).toHaveBeenCalledOnce())
    await useAgentStore.getState().cancelGeneration()
    await sending
    expect(cancelSpy).not.toHaveBeenCalled()
    request.resolve('late-parent-request')
    await vi.waitFor(() => expect(cancelSpy).toHaveBeenCalledWith('late-parent-request'))
    expect(useAgentStore.getState().activeRequestId).toBeNull()
  })

  it.each(['子取消', '父取消'] as const)('%s 后子会话已收尾，晚到 ID 仍发送底层取消', async cancelFrom => {
    const request = deferred<string>()
    const streamSpy = vi.spyOn(useLLMStore.getState(), 'generateStream').mockReturnValue(request.promise)
    const cancelSpy = vi.spyOn(useLLMStore.getState(), 'cancelGeneration').mockResolvedValue(undefined)
    let taskId = ''
    runnerMock.mockImplementation(async (task, deps) => {
      taskId = task.taskId
      try { await deps.generate([], 'm', undefined, undefined, deps.signal) }
      catch { return session(task.taskId, 'cancelled') }
      return session(task.taskId, 'completed')
    })
    seed()
    const running = useAgentStore.getState().runSubAgentTask({ description: 'P2 子任务' })
    await vi.waitFor(() => expect(streamSpy).toHaveBeenCalledOnce())
    if (cancelFrom === '子取消') useAgentStore.getState().cancelSubAgent(taskId)
    else await useAgentStore.getState().cancelGeneration()
    await expect(running).resolves.toMatchObject({ ok: false })
    expect(cancelSpy).not.toHaveBeenCalled()
    request.resolve(`late-child-${cancelFrom}`)
    await vi.waitFor(() => expect(cancelSpy).toHaveBeenCalledWith(`late-child-${cancelFrom}`))
    expect(useAgentStore.getState().getActiveConversation()!.subSessions![0].status).toBe('cancelled')
  })
})

describe('P2：store 归档错误与 flush 重试', () => {
  it.each(['success:false', 'IPC reject'] as const)('%s 不报保存成功；flush 重试保存最新失败快照', async failure => {
    const conv = seed()
    await expect(useAgentStore.getState().persistCurrent()).resolves.toBe(true)
    archiveWrite = async () => {
      if (failure === 'IPC reject') throw new Error('disk unavailable')
      return { success: false }
    }
    useAgentStore.setState({ conversations: [{ ...conv, title: '待重试最新标题' }] })
    await expect(useAgentStore.getState().persistCurrent()).resolves.toBe(false)
    const failed = useAgentStore.getState().archiveSaveStates[conv.id]
    expect(failed).toMatchObject({ status: 'failed', version: 2, savedVersion: 1 })
    expect(failed.error).toBeTruthy()
    expect(toast.error).toHaveBeenCalled()
    expect(parseArchive(archiveFiles.get(conv.id)!)!.title).toBe('P2')
    await expect(useAgentStore.getState().flushArchives()).resolves.toBe(false)
    expect(useAgentStore.getState().archiveSaveStates[conv.id].status).toBe('failed')
    archiveWrite = async (id, snapshot) => { archiveFiles.set(id, snapshot); return { success: true } }
    await expect(useAgentStore.getState().flushArchives()).resolves.toBe(true)
    const saved = useAgentStore.getState().archiveSaveStates[conv.id]
    expect(saved.status).toBe('saved')
    expect(saved.savedVersion).toBe(saved.version)
    expect(saved.error).toBeUndefined()
    expect(parseArchive(archiveFiles.get(conv.id)!)!.title).toBe('待重试最新标题')
  })

  it('flush 等待正在执行的 IPC 写入，不在 pending 时返回成功', async () => {
    const conv = seed()
    const writing = deferred<{ success: boolean }>()
    archiveWrite = async (id, snapshot) => {
      const result = await writing.promise
      archiveFiles.set(id, snapshot)
      return result
    }
    const saving = useAgentStore.getState().persistCurrent()
    let flushed = false
    const flushing = useAgentStore.getState().flushArchives().then(result => { flushed = true; return result })
    await Promise.resolve()
    expect(flushed).toBe(false)
    expect(useAgentStore.getState().archiveSaveStates[conv.id].status).toBe('pending')
    writing.resolve({ success: true })
    await expect(saving).resolves.toBe(true)
    await expect(flushing).resolves.toBe(true)
  })
})

describe('P2：真实引擎写入前归档屏障', () => {
  const names: string[] = []
  afterEach(() => { for (const name of names.splice(0)) toolRegistry.unregister(name) })

  async function realWrite(name: string) {
    const execute = vi.fn(async () => ({ success: true, content: '已提交', persistence: { target: name, verified: true } }))
    toolRegistry.register(buildAgentTool({
      name, description: 'P2 store barrier write', source: 'builtin',
      inputSchema: { type: 'object', properties: {} }, isReadOnly: false,
      requiresConfirmation: false, execute,
    }))
    names.push(name)
    const actual = await vi.importActual<typeof import('../services/agent/agent-engine')>('../services/agent/agent-engine')
    engineMock.mockImplementation((sys, hist, user, model, _generate, cb, signal, options, deps) => actual.runAgentLoop(
      sys, hist, user, model,
      vi.fn().mockResolvedValueOnce(`<tool_call>{"name":"${name}","arguments":{}}</tool_call>`).mockResolvedValueOnce('本次结果。'),
      cb, signal, options, deps,
    ))
    return execute
  }

  it.each(['success:false', 'IPC reject'] as const)('父归档 %s：真实注册写工具零执行，失败回执进入会话', async failure => {
    const name = `store_parent_barrier_${failure === 'IPC reject' ? 'reject' : 'false'}`
    const execute = await realWrite(name)
    const conv = seed()
    archiveWrite = async () => {
      if (failure === 'IPC reject') throw new Error('disk unavailable')
      return { success: false }
    }
    await useAgentStore.getState().sendMessage('保存正文')
    expect(engineMock).toHaveBeenCalledOnce()
    expect(execute).not.toHaveBeenCalled()
    expect(useAgentStore.getState().getActiveConversation()!.messages.at(-1)!.toolCalls).toEqual([
      expect.objectContaining({ toolName: name, status: 'failed', receipt: expect.objectContaining({ outcome: 'failed', verified: false }) }),
    ])
    await vi.waitFor(() => expect(useAgentStore.getState().archiveSaveStates[conv.id].status).toBe('failed'))
  })

  it('父屏障归档挂起期间取消：晚到保存成功也不执行写入', async () => {
    const execute = await realWrite('store_parent_cancel_barrier')
    seed()
    const saving = deferred<{ success: boolean }>()
    archiveWrite = async (id, snapshot) => {
      const result = await saving.promise
      archiveFiles.set(id, snapshot)
      return result
    }
    const sending = useAgentStore.getState().sendMessage('保存正文')
    await vi.waitFor(() => expect(useAgentStore.getState().getActiveConversation()!.messages.at(-1)!.toolCalls?.[0].status).toBe('running'))
    const cancelling = useAgentStore.getState().cancelGeneration()
    await sending
    expect(execute).not.toHaveBeenCalled()
    saving.resolve({ success: true })
    await cancelling
    await useAgentStore.getState().flushArchives()
    expect(execute).not.toHaveBeenCalled()
    expect(useAgentStore.getState().generating).toBe(false)
    expect(useAgentStore.getState().getActiveConversation()!.messages.at(-1)!.toolCalls?.[0].status).toBe('failed')
  })

  it.each(['success:false', 'IPC reject'] as const)('子归档 %s：真实 runner 和注册写工具零执行，子会话 failed', async failure => {
    const name = `store_child_barrier_${failure === 'IPC reject' ? 'reject' : 'false'}`
    const execute = await realWrite(name)
    const actual = await vi.importActual<typeof import('../services/agent/subagent/runner')>('../services/agent/subagent/runner')
    runnerMock.mockImplementation((task, deps) => actual.runSubAgent({ ...task, allowedTools: [name] }, { ...deps, buildPrompt: async () => 'system' }))
    seed()
    archiveWrite = async () => {
      if (failure === 'IPC reject') throw new Error('child disk unavailable')
      return { success: false }
    }
    await expect(useAgentStore.getState().runSubAgentTask({ description: '保存正文', tools: [name] })).resolves.toMatchObject({ ok: false })
    expect(execute).not.toHaveBeenCalled()
    const child = useAgentStore.getState().getActiveConversation()!.subSessions![0]
    expect(child.status).toBe('failed')
    expect(child.toolCalls).toEqual([expect.objectContaining({ status: 'failed', receipt: expect.objectContaining({ outcome: 'failed' }) })])
  })

  it.each(['子取消', '父取消', '关闭'] as const)('子保存屏障期间%s，晚到保存成功零写入并恢复取消终态', async cancellation => {
    const name = `store_child_cancel_${cancellation}`
    const execute = await realWrite(name)
    const actual = await vi.importActual<typeof import('../services/agent/subagent/runner')>('../services/agent/subagent/runner')
    runnerMock.mockImplementation((task, deps) => actual.runSubAgent({ ...task, allowedTools: [name] }, {
      ...deps, buildPrompt: async () => 'system',
      generate: async () => `<tool_call>{"name":"${name}","arguments":{}}</tool_call>`,
    }))
    const conv = seed()
    const saving = deferred<{ success: boolean }>()
    archiveWrite = async (id, snapshot) => {
      const result = await saving.promise
      archiveFiles.set(id, snapshot)
      return result
    }
    const running = useAgentStore.getState().runSubAgentTask({ description: '合成取消任务', tools: [name] })
    let cancelling: Promise<unknown> | undefined
    try {
      await vi.waitFor(() => expect(useAgentStore.getState().getActiveConversation()!.subSessions?.[0].toolCalls[0]?.status).toBe('running'))
      const childId = useAgentStore.getState().getActiveConversation()!.subSessions![0].id
      if (cancellation === '子取消') useAgentStore.getState().cancelSubAgent(childId)
      else if (cancellation === '父取消') cancelling = useAgentStore.getState().cancelGeneration()
      else cancelling = useAgentStore.getState().prepareForClose()
      await expect(running).resolves.toMatchObject({ ok: false })
      expect(execute).not.toHaveBeenCalled()
      saving.resolve({ success: true })
      await cancelling
      expect(await useAgentStore.getState().flushArchives()).toBe(true)
      const archived = parseArchive(archiveFiles.get(conv.id)!)!
      const child = archived.subSessions![0]
      expect(child.status).toBe('cancelled')
      expect(child.endedAt).toBeDefined()
      expect(child.toolCalls).toEqual([expect.objectContaining({ status: 'failed', receipt: expect.objectContaining({ outcome: 'failed' }) })])
      expect(child.messages.every(m => !m.streaming && (m.toolCalls ?? []).every(call => call.status !== 'running'))).toBe(true)
      useAgentStore.setState({ conversations: [], activeConversationId: null })
      await useAgentStore.getState().restoreArchives()
      expect(useAgentStore.getState().conversations.find(c => c.id === conv.id)!.subSessions![0].status).toBe('cancelled')
      expect(runnerMock).toHaveBeenCalledOnce()
      expect(execute).not.toHaveBeenCalled()
    } finally {
      saving.resolve({ success: true })
      await cancelling
      await running
    }
  })

  it('重启恢复 pending 写入转为 unknown，模型再次请求同参数也不重放', async () => {
    const name = 'store_restart_pending_write'
    const execute = await realWrite(name)
    const conv = seed()
    const pending: ToolCallInfo = {
      id: 'restart-pending', toolName: name, arguments: {}, status: 'running', turnId: 'restart-turn', step: 1,
      receipt: { turnId: 'restart-turn', step: 1, callId: 'restart-pending', toolName: name, target: name, outcome: 'unknown', verified: false },
    }
    useAgentStore.setState({ conversations: [{ ...conv, messages: [{ id: 'restart-message', role: 'assistant', content: '', createdAt: 0, streaming: true, toolCalls: [pending] }] }] })
    await useAgentStore.getState().persistCurrent()
    useAgentStore.setState({ conversations: [], activeConversationId: null })
    await useAgentStore.getState().restoreArchives()
    useAgentStore.getState().selectConversation(conv.id)
    const restored = useAgentStore.getState().getActiveConversation()!.messages[0]
    expect(restored.streaming).toBe(false)
    expect(restored.toolCalls![0]).toMatchObject({ status: 'failed', receipt: { outcome: 'unknown', verified: false } })
    expect(engineMock).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    await useAgentStore.getState().sendMessage('保存正文')
    expect(execute).not.toHaveBeenCalled()
    expect(useAgentStore.getState().getActiveConversation()!.messages.at(-1)!.toolCalls![0].receipt?.outcome).toBe('unknown')
  })
})

describe('P2：恢复晚到失效', () => {
  it.each(['新恢复完成', '退出完成'] as const)('operation-list 挂起后%s，旧恢复不注入会话', async invalidation => {
    const conv = seed()
    await useAgentStore.getState().persistCurrent()
    useAgentStore.setState({ conversations: [], activeConversationId: null })
    const gate = deferred<null>()
    const original = mockInvoke.getMockImplementation()!
    mockInvoke.mockImplementation(async (channel, ...args) => channel === 'agent:operation-list' ? gate.promise : original(channel, ...args))
    try {
      const restoring = useAgentStore.getState().restoreArchives()
      await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('agent:operation-list', '/mock/proj'))
      archiveFiles.clear()
      if (invalidation === '退出完成') await useAgentStore.getState().prepareForClose()
      else await useAgentStore.getState().restoreArchives()
      gate.resolve(null)
      await restoring
      expect(useAgentStore.getState().conversations.some(c => c.id === conv.id)).toBe(false)
      expect(engineMock).not.toHaveBeenCalled()
    } finally { mockInvoke.mockImplementation(original) }
  })
})

describe('P2：工具完成但总结未返回时 prepareForClose', () => {
  it('退出超时留窗，重复关闭单飞，晚到收尾保留证据且显式重试成功', async () => {
    const gate = deferred<void>()
    let callbacks!: AgentEngineCallbacks
    engineMock.mockImplementation(async (_sys, _hist, _user, _model, _generate, cb) => {
      callbacks = cb
      await gate.promise
    })
    const conv = seed()
    const sending = useAgentStore.getState().sendMessage('合成退出超时')
    await vi.waitFor(() => expect(engineMock).toHaveBeenCalledOnce())
    const completed: ToolCallInfo = { ...writeCall(), status: 'completed', turnId: 'close-timeout', step: 1,
      receipt: { turnId: 'close-timeout', step: 1, callId: 'write-p2', toolName: 'write_file', target: 'drafts/c1.md', outcome: 'committed', verified: true } }
    callbacks.onToolCallComplete(completed)
    await useAgentStore.getState().flushArchives()
    vi.useFakeTimers()
    try {
      const first = useAgentStore.getState().prepareForClose()
      const second = useAgentStore.getState().prepareForClose()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(await first).toBe(false)
      expect(await second).toBe(false)
      await useAgentStore.getState().sendMessage('超时后不得启动')
      expect(await useAgentStore.getState().runSubAgentTask({ description: '超时后不得派发' })).toMatchObject({ ok: false })
      expect(engineMock).toHaveBeenCalledOnce()
      expect(runnerMock).not.toHaveBeenCalled()
      const retry = useAgentStore.getState().prepareForClose()
      gate.resolve()
      await sending
      expect(await retry).toBe(true)
      expect(await useAgentStore.getState().prepareForClose()).toBe(true)
      expect(parseArchive(archiveFiles.get(conv.id)!)!.messages.at(-1)!.toolCalls).toEqual([completed])
      expect(useAgentStore.getState().archiveSaveStates[conv.id].status).toBe('saved')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      gate.resolve()
      await sending
      await useAgentStore.getState().prepareForClose()
      vi.useRealTimers()
    }
  })

  it('归档挂起超时不假保存、不重复取消，晚到完成后重试成功', async () => {
    const conv = seed()
    const gate = deferred<{ success: boolean }>()
    let writes = 0
    archiveWrite = async (id, snapshot) => {
      writes++
      const result = await gate.promise
      archiveFiles.set(id, snapshot)
      return result
    }
    const originalInvoke = ipc.invoke.bind(ipc) as (
      channel: Parameters<typeof ipc.invoke>[0], ...args: unknown[]
    ) => ReturnType<typeof ipc.invoke>
    const invokeSpy = vi.spyOn(ipc, 'invoke').mockImplementation((channel, ...args) => {
      if (channel === 'fs:agent-archive-write') return archiveWrite(String(args[0]), String(args[1])) as ReturnType<typeof ipc.invoke>
      return originalInvoke(channel, ...args)
    })
    vi.useFakeTimers()
    try {
      const first = useAgentStore.getState().prepareForClose()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(await first).toBe(false)
      expect(useAgentStore.getState().archiveSaveStates[conv.id].status).toBe('pending')
      const retry = useAgentStore.getState().prepareForClose()
      expect(writes).toBe(1)
      gate.resolve({ success: true })
      expect(await retry).toBe(true)
      expect(useAgentStore.getState().archiveSaveStates[conv.id].status).toBe('saved')
    } finally {
      gate.resolve({ success: true })
      await useAgentStore.getState().prepareForClose()
      invokeSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('先落盘完成工具/产物；关闭等待循环收尾，缓冲文本与回执可恢复', async () => {
    const release = deferred<void>()
    let callbacks!: AgentEngineCallbacks
    let aborted = false
    engineMock.mockImplementation(async (_sys, _hist, _user, _model, _generate, cb, signal) => {
      callbacks = cb
      signal?.addEventListener('abort', () => { aborted = true }, { once: true })
      await release.promise
    })
    const conv = seed()
    const sending = useAgentStore.getState().sendMessage('保存第一章')
    await vi.waitFor(() => expect(engineMock).toHaveBeenCalledOnce())
    const completed: ToolCallInfo = {
      ...writeCall(), status: 'completed', result: '已写入', turnId: 'turn-p2', step: 1,
      receipt: { turnId: 'turn-p2', step: 1, callId: 'write-p2', toolName: 'write_file', target: 'drafts/c1.md', outcome: 'committed', verified: true },
    }
    const artifacts = [{ type: 'file_created' as const, name: '第一章', path: 'drafts/c1.md' }]
    callbacks.onToolCallComplete(completed, artifacts)
    await useAgentStore.getState().flushArchives()
    const beforeClose = parseArchive(archiveFiles.get(conv.id)!)!
    expect(beforeClose.messages.at(-1)!.toolCalls).toEqual([completed])
    expect(beforeClose.messages.at(-1)!.artifacts).toEqual(artifacts)
    expect(useAgentStore.getState().generating).toBe(true)
    callbacks.onTextChunk('正在总结')
    callbacks.onTextChunk('缓冲中的末尾')
    let closed = false
    const closing = useAgentStore.getState().prepareForClose().then(result => { closed = true; return result })
    await Promise.resolve()
    expect(aborted).toBe(true)
    expect(closed).toBe(false)
    await useAgentStore.getState().sendMessage('退出期间不得发新任务')
    expect(engineMock).toHaveBeenCalledOnce()
    expect(await useAgentStore.getState().runSubAgentTask({ description: '退出期间不得派发' })).toMatchObject({ ok: false })
    expect(runnerMock).not.toHaveBeenCalled()
    release.resolve()
    await sending
    await expect(closing).resolves.toBe(true)
    const restored = parseArchive(archiveFiles.get(conv.id)!)!
    const assistant = restored.messages.at(-1)!
    expect(assistant.streaming).not.toBe(true)
    expect(assistant.content).toContain('正在总结缓冲中的末尾')
    expect(assistant.toolCalls).toEqual([completed])
    expect(assistant.artifacts).toEqual(artifacts)
    expect(useAgentStore.getState().archiveSaveStates[conv.id].status).toBe('saved')
  })
})
