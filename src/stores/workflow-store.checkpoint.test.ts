// @vitest-environment jsdom
/**
 * workflow-checkpoint v2（L2 任务5）专项：
 * - save/load/restore 从 localStorage 迁到 DB（经 Task 4 IPC db:checkpoint-*）
 * - runDefs + contextData 重建信息随 checkpoint 持久化
 * - localStorage 兜底迁移（DB 空读旧数据并写回）
 * - 损坏降级（非法/activeRuns 非数组 → 视为无 checkpoint，不崩）
 * - 恢复决断：running 自动重放 / waiting 点继续重放（跨重启真续跑）
 * - 跨任务约束 I-1：恢复态对齐 running，断点重放能打到 completed
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { executeRunFromIndex, useWorkflowStore, type StepExecutor } from './workflow-store'
import { toast } from '../components/ui/Toast'
import { registerWorkflow } from '../services/workflows/workflow-registry'

const CHECKPOINT_KEY = 'vela-workflow-checkpoint'

// vi.hoisted：mock 工厂需要引用共享状态（dbMap/记录），且必须在 hoisted 作用域内定义
const h = vi.hoisted(() => {
  const dbMap = new Map<string, string>()
  const invoke = vi.fn(async (...args: unknown[]) => {
    const ch = args[0] as string
    if (ch === 'db:checkpoint-save') {
      dbMap.set('cp', JSON.stringify(args[1]))
      return { success: true }
    }
    if (ch === 'db:checkpoint-load') {
      return { success: true, data: dbMap.get('cp') ? JSON.parse(dbMap.get('cp')!) : null }
    }
    if (ch === 'db:checkpoint-clear') {
      dbMap.delete('cp')
      return { success: true }
    }
    return { success: true }
  })
  return { dbMap, invoke, seen: [] as string[], seenData: [] as Record<string, unknown>[] }
})

vi.mock('../services/ipc-client', () => ({
  ipc: { invoke: (...a: unknown[]) => h.invoke(...(a as [])) },
}))

// 注册一个可重建的 workflow（type: post_process），executor 记录运行步骤供断言断点重放 +
// 记录 executor 读到的 ctx.data（IMP-1：waiting 续跑须消费 checkpoint contextData，而非空）
registerWorkflow('post_process', () => ({
  type: 'post_process',
  title: '后处理（L2 测试桩）',
  steps: ['a', 'b', 'c'].map((name) => ({
    name,
    description: name,
    executor: async (_step, ctx) => {
      h.seen.push(name)
      h.seenData.push({ ...ctx.data })
      return name
    },
  })),
  rehydrateParams: {},
}))

/** 构造一个 3 步（a/b/c）的 post_process run 快照（checkpoint 内嵌形状） */
function makeRun(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    type: 'post_process' as const,
    title: `run-${id}`,
    status: 'running' as const,
    currentStepIndex: 0,
    createdAt: '2026-09-05T00:00:00.000Z',
    steps: [
      { id: `${id}-s0`, name: 'a', description: 'a', status: 'pending' as const, logs: [] },
      { id: `${id}-s1`, name: 'b', description: 'b', status: 'pending' as const, logs: [] },
      { id: `${id}-s2`, name: 'c', description: 'c', status: 'pending' as const, logs: [] },
    ],
    rehydrateParams: { seed: id },
    ...over,
  }
}

const resetStore = () => {
  useWorkflowStore.setState({
    activeRuns: [],
    history: [],
    globalLogs: [],
    waitingRuns: {},
    currentRun: null,
    waitingForConfirm: false,
    waitingAfterStepIndex: -1,
  })
}

/** 轮询等待某条件成立（异步断点重放需等待 async 链路完成） */
async function waitFor(fn: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 1))
  }
}

beforeEach(() => {
  h.dbMap.clear()
  h.seen.length = 0
  h.seenData.length = 0
  localStorage.clear()
  resetStore()
})

describe('工作流历史结果持久化', () => {
  it('普通 run 取消刷缓冲，晚到正文与 undefined 结果仍留在历史', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const next = vi.fn(async () => '不得执行')
    const starting = useWorkflowStore.getState().startWorkflow({
      type: 'post_process', title: '取消正文', steps: [
        { name: '正文', description: '', executor: async (_step, _context, callbacks) => {
          callbacks.appendText('取消前')
          await gate
          callbacks.appendText('晚到尾文')
        } },
        { name: '后续', description: '', executor: next },
      ],
    })
    await vi.waitFor(() => expect(useWorkflowStore.getState().activeRuns[0]?.steps[0].status).toBe('running'))
    const id = useWorkflowStore.getState().activeRuns[0].id
    useWorkflowStore.getState().cancelWorkflow(id)
    expect(useWorkflowStore.getState().history[0].steps[0].result).toBe('取消前')
    release()
    await starting
    expect(useWorkflowStore.getState().history[0].steps[0].result).toBe('取消前晚到尾文')
    expect(useWorkflowStore.getState().history[0].status).toBe('failed')
    expect(next).not.toHaveBeenCalled()
  })
  it('执行器拒绝时仍保留尚未刷出的尾文', async () => {
    await useWorkflowStore.getState().startWorkflow({
      type: 'post_process', title: '失败正文', steps: [{ name: '正文', description: '', executor: async (_step, _context, callbacks) => {
        callbacks.appendText('失败前尾文')
        throw new Error('失败')
      } }],
    })
    expect(useWorkflowStore.getState().history[0].steps[0].result).toBe('失败前尾文')
  })
  it('已取消历史 run 的晚到执行入口不启动也不改回运行', async () => {
    const run = makeRun('late-entry', { status: 'failed', cancellationRequestedAt: '2026-11-09T00:00:00Z' })
    useWorkflowStore.setState({ history: [run] })
    const execute = vi.fn(async () => '不得执行')
    await executeRunFromIndex(run, { type: 'post_process', title: '晚到', steps: [{ name: 's', description: '', executor: execute }] }, 0, {})
    expect(execute).not.toHaveBeenCalled()
    expect(useWorkflowStore.getState().history[0].status).toBe('failed')
  })
  it('Agent 未完成工作流恢复为暂停，不能自动重放', async () => {
    h.dbMap.set('cp', JSON.stringify({ activeRuns: [makeRun('agent-interrupted', { operationId: 'agent-op', startupState: 'started' })],
      waitingRuns: {}, savedAt: '2026-11-09T00:00:00Z', runDefs: { 'agent-interrupted': { type: 'post_process', params: {} } },
    }))
    await useWorkflowStore.getState().restoreCheckpoint()
    expect(useWorkflowStore.getState().activeRuns[0].status).toBe('paused')
    expect(h.seen).toEqual([])
  })
  it('蓝图暂停会中断请求并保留已提交进度，关闭和再次恢复不丢断点', async () => {
    let entered = false
    const starting = useWorkflowStore.getState().startWorkflow({
      type: 'directory', title: '暂停蓝图', rehydrateParams: { mode: 'full' }, steps: [{
        name: '生成', description: '', executor: async (_step, context) => {
          context.data.newBlueprints = [{ chapterNumber: 1, title: '已保存' }]
          await context.checkpoint?.()
          entered = true
          await new Promise<void>((_resolve, reject) => context.signal!.addEventListener('abort', () => reject(new DOMException('暂停', 'AbortError')), { once: true }))
        },
      }],
    })
    await waitFor(() => entered)
    const id = useWorkflowStore.getState().activeRuns[0].id
    useWorkflowStore.getState().pauseWorkflow(id)
    await starting
    expect(useWorkflowStore.getState().activeRuns[0].status).toBe('paused')
    expect(await useWorkflowStore.getState().prepareForClose()).toBe(true)
    resetStore()
    await useWorkflowStore.getState().restoreCheckpoint()
    expect(useWorkflowStore.getState().activeRuns[0].status).toBe('paused')
    await useWorkflowStore.getState().flushCheckpoint()
    const cp = JSON.parse(h.dbMap.get('cp')!)
    expect(cp.contextData[id].newBlueprints).toEqual([{ chapterNumber: 1, title: '已保存' }])
  })

  it('暂停恢复沿用断点上下文，连点继续只启动一次', async () => {
    registerWorkflow('directory', () => ({ type: 'directory', title: '续跑', rehydrateParams: { mode: 'full' }, steps: [{
      name: '生成', description: '', executor: async (_step, ctx) => {
        h.seen.push('resume')
        h.seenData.push({ ...ctx.data })
      },
    }] }))
    h.dbMap.set('cp', JSON.stringify({ activeRuns: [makeRun('paused-dir', { type: 'directory', status: 'paused' })],
      waitingRuns: {}, savedAt: '2026-11-10T00:00:00Z', runDefs: { 'paused-dir': { type: 'directory', params: { mode: 'full' } } },
      contextData: { 'paused-dir': { newBlueprints: [{ chapterNumber: 1 }] } },
    }))
    await useWorkflowStore.getState().restoreCheckpoint()
    expect(h.seen).toEqual([])
    useWorkflowStore.getState().confirmContinue('paused-dir')
    useWorkflowStore.getState().confirmContinue('paused-dir')
    await waitFor(() => useWorkflowStore.getState().history.some(r => r.id === 'paused-dir'))
    expect(h.seen).toEqual(['resume'])
    expect(h.seenData[0].newBlueprints).toEqual([{ chapterNumber: 1 }])
  })

  it('重新生成等待旧请求收尾，使用新run且不沿用旧蓝图断点', async () => {
    registerWorkflow('directory', () => ({ type: 'directory', title: '重生成', rehydrateParams: { mode: 'full' }, steps: [{
      name: '生成', description: '', executor: async (_step, ctx) => { h.seenData.push({ ...ctx.data }) },
    }] }))
    let entered = false
    const starting = useWorkflowStore.getState().startWorkflow({ type: 'directory', title: '旧任务', rehydrateParams: { mode: 'append' }, steps: [{
      name: '生成', description: '', executor: async (_step, ctx) => {
        ctx.data.newBlueprints = [{ chapterNumber: 1 }]
        entered = true
        await new Promise<void>((_resolve, reject) => ctx.signal!.addEventListener('abort', () => reject(new DOMException('停止', 'AbortError')), { once: true }))
      },
    }] })
    await waitFor(() => entered)
    const oldId = useWorkflowStore.getState().activeRuns[0].id
    await useWorkflowStore.getState().restartWorkflow(oldId)
    await starting
    expect(h.seenData).toEqual([{}])
    expect(useWorkflowStore.getState().history).toHaveLength(2)
    expect(useWorkflowStore.getState().history[0].id).not.toBe(oldId)
    expect(useWorkflowStore.getState().history[1].cancellationRequestedAt).toBeTruthy()
  })

  it('已终止历史蓝图继续复用同一任务，不读取其他任务的旧库进度', async () => {
    const registry = await import('../services/workflows/workflow-registry')
    const factory = vi.spyOn(registry, 'rehydrateWorkflow').mockImplementationOnce((_type, params) => ({ type: 'directory' as const, title: '继续', rehydrateParams: params,
      steps: [{ name: 's', description: '', executor: async () => {} }],
    }))
    useWorkflowStore.setState({ history: [makeRun('cancelled-dir', { type: 'directory', status: 'failed', cancellationRequestedAt: '2026-11-10', rehydrateParams: { mode: 'full', count: 100 } })] })
    await useWorkflowStore.getState().continueDirectory('cancelled-dir')
    expect(factory).toHaveBeenCalledWith('directory', { mode: 'full', count: 100, continueSaved: false })
    factory.mockRestore()
    expect(useWorkflowStore.getState().history[0].status).toBe('completed')
    expect(useWorkflowStore.getState().history[0].id).toBe('cancelled-dir')
  })

  it('删除历史持久化且只清输出，不删除蓝图正文', async () => {
    useWorkflowStore.setState({ history: [makeRun('delete-me', { status: 'completed' })], selectedRunId: 'delete-me' })
    await useWorkflowStore.getState().deleteHistory('delete-me')
    expect(useWorkflowStore.getState().history).toEqual([])
    expect(useWorkflowStore.getState().selectedRunId).toBeNull()
    expect(h.invoke).toHaveBeenCalledWith('fs:workflow-output-delete-run', 'delete-me')
    expect(h.invoke.mock.calls.some(c => /^db:(blueprint|draft|character).*delete/.test(String(c[0])))).toBe(false)
    resetStore()
    await useWorkflowStore.getState().restoreCheckpoint()
    expect(useWorkflowStore.getState().history).toEqual([])
  })
  it('暂停活跃任务不可删除；持久化失败恢复历史且不清理输出', async () => {
    useWorkflowStore.setState({ activeRuns: [makeRun('paused', { status: 'paused' })] })
    await expect(useWorkflowStore.getState().deleteHistory('paused')).rejects.toThrow('不能删除')
    useWorkflowStore.setState({ activeRuns: [], history: [makeRun('keep', { status: 'completed' })] })
    h.invoke.mockImplementationOnce(async () => ({ success: false }))
    await expect(useWorkflowStore.getState().deleteHistory('keep')).rejects.toThrow()
    expect(useWorkflowStore.getState().history[0].id).toBe('keep')
    expect(h.invoke.mock.calls.some(c => c[0] === 'fs:workflow-output-delete-run' && c[1] === 'keep')).toBe(false)
  })

  it('当前输出173章的完整行恢复到原任务，不把旧库300章当进度', async () => {
    const directory = await import('../services/workflows/directory-workflow')
    const save = vi.spyOn(directory, 'saveAllBlueprints').mockResolvedValueOnce(undefined)
    const registry = await import('../services/workflows/workflow-registry')
    let received: Record<string, unknown> | undefined
    const factory = vi.spyOn(registry, 'rehydrateWorkflow').mockImplementationOnce(() => ({ type: 'directory', title: '原任务', steps: [
      { name: '读取', description: '', executor: async () => {} },
      { name: '生成', description: '', executor: async (_step, ctx) => { received = ctx.data } },
    ] }))
    const old = makeRun('173-run', { type: 'directory', status: 'failed', steps: [
      { id: 's0', name: '读取', description: '', status: 'completed', logs: [] },
      { id: 's1', name: '生成', description: '', status: 'running', result: Array.from({ length: 173 }, (_, i) => `| ${i + 1} | 完整章 | 发展 | 目的 | 人物 | 事件 | 悬念 |`).join('\n') + '\n| 174 | 未完成 |', logs: [] },
    ], resumeData: { architecture: 'world', newBlueprints: [{ chapterNumber: 172 }] } })
    useWorkflowStore.setState({ history: [old] })
    await useWorkflowStore.getState().continueDirectory('173-run')
    expect((received?.newBlueprints as { chapterNumber: number }[]).map(b => b.chapterNumber)).toEqual(Array.from({ length: 173 }, (_, i) => i + 1))
    expect(save.mock.calls[0][0]).toHaveLength(173)
    expect(h.invoke.mock.calls.some(c => c[0] === 'db:blueprint-get-all')).toBe(false)
    expect(useWorkflowStore.getState().history[0].id).toBe('173-run')
    save.mockRestore(); factory.mockRestore()
  })

  it('异常退出恢复的蓝图步骤不再显示运行且不自动调用模型', async () => {
    h.dbMap.set('cp', JSON.stringify({ activeRuns: [makeRun('crash-dir', { type: 'directory', steps: [{ id: 's', name: 's', description: '', status: 'running', progress: 50, logs: [] }] })], waitingRuns: {}, savedAt: '2026-11-10' }))
    await useWorkflowStore.getState().restoreCheckpoint()
    expect(useWorkflowStore.getState().activeRuns[0].status).toBe('paused')
    expect(useWorkflowStore.getState().activeRuns[0].steps[0].status).toBe('pending')
    expect(h.seen).toEqual([])
  })

  it('退出超时保持工作流禁入，重复关闭单飞并保存晚到尾文', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const execute = vi.fn<StepExecutor>(async (_step, _context, callbacks) => {
      callbacks.appendText('退出前')
      await gate
      callbacks.appendText('晚到尾文')
    })
    const definition = { type: 'post_process' as const, title: '合成关闭超时', steps: [{ name: 's', description: '', executor: execute }] }
    const starting = useWorkflowStore.getState().startWorkflow(definition)
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
    const cancel = vi.spyOn(useWorkflowStore.getState(), 'cancelWorkflow')
    vi.useFakeTimers()
    try {
      const first = useWorkflowStore.getState().prepareForClose()
      const second = useWorkflowStore.getState().prepareForClose()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(await first).toBe(false)
      expect(await second).toBe(false)
      expect(cancel).toHaveBeenCalledOnce()
      await expect(useWorkflowStore.getState().startWorkflow(definition)).rejects.toThrow('保存退出')
      const retry = useWorkflowStore.getState().prepareForClose()
      release()
      await starting
      expect(await retry).toBe(true)
      expect(cancel).toHaveBeenCalledOnce()
      expect(execute).toHaveBeenCalledOnce()
      const checkpoint = JSON.parse(h.dbMap.get('cp')!)
      expect(checkpoint.history[0].steps[0].result).toBe('退出前晚到尾文')
      expect(checkpoint.history[0].status).toBe('failed')
      await vi.advanceTimersByTimeAsync(100)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      release()
      await starting
      await useWorkflowStore.getState().prepareForClose()
      cancel.mockRestore()
      vi.useRealTimers()
    }
  })

  it('checkpoint 读取晚于关闭完成时不恢复旧工作流', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const original = h.invoke.getMockImplementation()!
    const cp = { activeRuns: [makeRun('close-restore')], waitingRuns: {}, savedAt: '2026-11-09T00:00:00Z',
      runDefs: { 'close-restore': { type: 'post_process', params: {} } },
    }
    h.invoke.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === 'db:checkpoint-load') { await gate; return { success: true, data: cp } }
      return original(...args)
    })
    try {
      const restoring = useWorkflowStore.getState().restoreCheckpoint()
      await useWorkflowStore.getState().prepareForClose()
      release()
      expect(await restoring).toBeNull()
      expect(useWorkflowStore.getState().activeRuns).toHaveLength(0)
      expect(h.seen).toEqual([])
    } finally { release(); h.invoke.mockImplementation(original) }
  })
  it('保存明确失败时flush返回false而非假成功', async () => {
    const notify = vi.spyOn(toast, 'error').mockImplementation(() => {})
    useWorkflowStore.setState({ history: [makeRun('failed-save', { status: 'completed' })] })
    h.invoke.mockResolvedValueOnce({ success: false })
    expect(await useWorkflowStore.getState().flushCheckpoint()).toBe(false)
    expect(notify).toHaveBeenCalled()
    expect(await useWorkflowStore.getState().flushCheckpoint()).toBe(true)
    notify.mockRestore()
  })
  it('保存失败通知自身抛错也返回 false，重试仍可成功', async () => {
    const notify = vi.spyOn(toast, 'error').mockImplementation(() => { throw new Error('通知渲染失败') })
    useWorkflowStore.setState({ history: [makeRun('failed-notify', { status: 'completed' })] })
    h.invoke.mockResolvedValueOnce({ success: false })
    try {
      expect(await useWorkflowStore.getState().flushCheckpoint()).toBe(false)
      expect(await useWorkflowStore.getState().flushCheckpoint()).toBe(true)
    } finally { notify.mockRestore() }
  })
  it('第二启动checkpoint期间取消，不可复用未执行的started回执', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const original = h.invoke.getMockImplementation()!
    let saves = 0
    h.invoke.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === 'db:checkpoint-save' && ++saves === 2) await gate
      return original(...args)
    })
    const execute = vi.fn(async () => '不应执行')
    const definition = { type: 'post_process' as const, title: '取消启动', steps: [{ name: 's', description: '', executor: execute }] }
    const starting = useWorkflowStore.getState().startWorkflow(definition, false, { operationId: 'cancel-start' })
    const rejection = expect(starting).rejects.toBeDefined()
    await vi.waitFor(() => expect(saves).toBe(2))
    useWorkflowStore.getState().cancelWorkflow()
    release(); await rejection
    expect(useWorkflowStore.getState().history[0].startupState).not.toBe('started')
    await expect(useWorkflowStore.getState().startWorkflow(definition, false, { operationId: 'cancel-start' })).rejects.toBeDefined()
    expect(execute).not.toHaveBeenCalled()
    h.invoke.mockImplementation(original)
  })
  it('完成后仅剩历史也保存，重开后正文可读且不重跑', async () => {
    await useWorkflowStore.getState().startWorkflow({
      type: 'post_process', title: '结果持久化',
      steps: [{ name: '正文', description: '', executor: async () => '完整正文' }],
    })
    expect(h.dbMap.has('cp')).toBe(true)
    resetStore()
    await useWorkflowStore.getState().restoreCheckpoint()
    expect(useWorkflowStore.getState().history[0].steps[0].result).toBe('完整正文')
    expect(useWorkflowStore.getState().activeRuns).toHaveLength(0)
    await useWorkflowStore.getState().restoreCheckpoint()
    expect(useWorkflowStore.getState().history).toHaveLength(1)
    expect(h.seen).toEqual([])
  })

  it('取消全部保留历史；项目重置只清内存、不清数据库', async () => {
    useWorkflowStore.setState({ activeRuns: [makeRun('cancelled')] })
    useWorkflowStore.getState().cancelWorkflow()
    expect(await useWorkflowStore.getState().flushCheckpoint()).toBe(true)
    expect(JSON.parse(h.dbMap.get('cp')!).history[0].status).toBe('failed')
    useWorkflowStore.getState().resetProject()
    expect(useWorkflowStore.getState().history).toHaveLength(0)
    expect(h.dbMap.has('cp')).toBe(true)
  })
})

describe('workflow-checkpoint v2（L2）', () => {
  it('restoreCheckpoint v2：waiting 断点重放（跨重启真续跑，I-1 对齐 running → completed）', async () => {
    // waitingAfterStepIndex=1 → 断点续跑应从步骤 2（c）开始，seen 只含断点后步骤
    const cp = {
      activeRuns: [
        makeRun('run-wait', {
          currentStepIndex: 1,
          status: 'waiting',
          steps: [
            { id: 's0', name: 'a', description: 'a', status: 'completed', result: 'a', logs: [] },
            { id: 's1', name: 'b', description: 'b', status: 'completed', result: 'b', logs: [] },
            { id: 's2', name: 'c', description: 'c', status: 'pending', logs: [] },
          ],
        }),
      ],
      waitingRuns: { 'run-wait': { waitingForConfirm: true, waitingAfterStepIndex: 1 } },
      savedAt: '2026-09-05T00:01:00.000Z',
      runDefs: { 'run-wait': { type: 'post_process', params: { seed: 'run-wait' } } },
      contextData: { 'run-wait': { shared: 'ctx' } },
    }
    h.dbMap.set('cp', JSON.stringify(cp))

    const restored = await useWorkflowStore.getState().restoreCheckpoint()
    expect(restored).not.toBeNull()
    const waitingRun = useWorkflowStore.getState().activeRuns.find((r) => r.id === 'run-wait')
    expect(waitingRun?.status).toBe('waiting')
    // 等待标记保留（confirmContinue 依赖 waitingAfterStepIndex 定位断点）
    expect(useWorkflowStore.getState().waitingRuns['run-wait']?.waitingAfterStepIndex).toBe(1)
    // waiting 未自动重放：seen 为空
    expect(h.seen).toEqual([])

    // 点「继续」→ 断点重放：只跑断点后步骤（c），并靠 I-1（restore 态对齐 running）打到 completed
    useWorkflowStore.getState().confirmContinue('run-wait')
    await waitFor(() => useWorkflowStore.getState().history.some((r) => r.id === 'run-wait'))
    const finalRun = useWorkflowStore.getState().history.find((r) => r.id === 'run-wait')
    expect(finalRun?.status).toBe('completed')
    expect(h.seen).toEqual(['c'])
    // IMP-1：waiting 续跑消费 checkpoint 的 contextData（executor 读到断点共享数据而非空）
    expect(h.seenData).toEqual([{ shared: 'ctx' }])
  })

  it('restoreCheckpoint v2：running 中断自动重放（从 currentStepIndex 立即续跑）', async () => {
    const cp = {
      activeRuns: [
        makeRun('run-live', {
          currentStepIndex: 1,
          status: 'running',
          steps: [
            { id: 's0', name: 'a', description: 'a', status: 'completed', result: 'a', logs: [] },
            { id: 's1', name: 'b', description: 'b', status: 'pending', logs: [] },
            { id: 's2', name: 'c', description: 'c', status: 'pending', logs: [] },
          ],
        }),
      ],
      waitingRuns: {},
      savedAt: '2026-09-05T00:02:00.000Z',
      runDefs: { 'run-live': { type: 'post_process', params: { seed: 'run-live' } } },
      contextData: { 'run-live': { shared: 'ctx' } },
    }
    h.dbMap.set('cp', JSON.stringify(cp))

    await useWorkflowStore.getState().restoreCheckpoint()
    // running 中断 → 立即自动重放（从 currentStepIndex=1 起跑 b、c）
    await waitFor(() => useWorkflowStore.getState().history.some((r) => r.id === 'run-live'))
    const finalRun = useWorkflowStore.getState().history.find((r) => r.id === 'run-live')
    expect(finalRun?.status).toBe('completed')
    expect(h.seen).toEqual(['b', 'c'])
  })

  it('restoreCheckpoint v2：不可重建 → 旧兜底（waiting→failed / running→paused，不自动重放）', async () => {
    // 用未注册的 type（rehydrateWorkflow 返回 null）走旧兜底
    const legacyRun = makeRun('run-old', {
      type: 'chapter_creation' as const,
      status: 'running',
      steps: [
        { id: 'x-s0', name: 'a', description: 'a', status: 'completed', result: 'a', logs: [] },
        { id: 'x-s1', name: 'b', description: 'b', status: 'pending', logs: [] },
      ],
    })
    const cp = {
      activeRuns: [legacyRun],
      waitingRuns: { 'run-old': { waitingForConfirm: true, waitingAfterStepIndex: 0 } },
      savedAt: '2026-09-05T00:03:00.000Z',
    }
    h.dbMap.set('cp', JSON.stringify(cp))

    await useWorkflowStore.getState().restoreCheckpoint()
    const restoredRun = useWorkflowStore.getState().activeRuns.find((r) => r.id === 'run-old')
    // 不可重建的 waiting → failed，且等待标记清除
    expect(restoredRun?.status).toBe('failed')
    expect(useWorkflowStore.getState().waitingRuns['run-old']).toBeUndefined()
  })

  it('saveCheckpoint 经迁移写回 DB：含 runDefs + contextData 重建信息', async () => {
    // DB 空（h.dbMap 无 'cp'）+ localStorage 有旧 checkpoint（含 runDefs/contextData）
    const legacyCp = {
      activeRuns: [
        makeRun('run-legacy', {
          type: 'chapter_creation' as const,
          currentStepIndex: 0,
          steps: [
            { id: 's0', name: 'a', description: 'a', status: 'completed', result: 'a', logs: [] },
          ],
        }),
      ],
      waitingRuns: {},
      savedAt: '2026-09-05T00:04:00.000Z',
      runDefs: { 'run-legacy': { type: 'chapter_creation', params: { seed: 'run-legacy' } } },
      contextData: { 'run-legacy': { shared: 'ctx' } },
    }
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(legacyCp))

    const restored = await useWorkflowStore.getState().restoreCheckpoint()
    expect(restored).not.toBeNull()
    // DB 空 → 兜底读 localStorage 并迁移写回 DB
    expect(h.dbMap.get('cp')).toBeTruthy()
    const migrated = JSON.parse(h.dbMap.get('cp')!)
    // 重建信息随迁移写回：runDefs + contextData 均保留
    expect(migrated.runDefs['run-legacy']).toEqual({ type: 'chapter_creation', params: { seed: 'run-legacy' } })
    expect(migrated.contextData['run-legacy']).toEqual({ shared: 'ctx' })
  })

  it('restoreCheckpoint v2：损坏降级（activeRuns 非数组/非法 JSON）→ 视为无 checkpoint，不崩', async () => {
    h.dbMap.set('cp', JSON.stringify({ activeRuns: 'corrupt', savedAt: 'x' }))
    await expect(useWorkflowStore.getState().restoreCheckpoint()).resolves.toBeNull()
    expect(useWorkflowStore.getState().activeRuns).toHaveLength(0)
  })

  // ===== L2 final review fix wave（final whole-branch review）=====

  it('legacy checkpoint（runDefs 缺失）→ 走安全兜底非误路由（waiting→failed / running→paused，不自动重放）', async () => {
    // registry 已注册 post_process（rehydrateWorkflow 恒可重建）；但 checkpoint 缺 runDefs
    // （legacy pre-L2 localStorage 旧数据）→ 必须走 else 兜底，不得用空 params 命中工厂误路由。
    const legacyRun = makeRun('run-legacy-missing', {
      status: 'running',
      currentStepIndex: 1,
      steps: [
        { id: 's0', name: 'a', description: 'a', status: 'completed', result: 'a', logs: [] },
        { id: 's1', name: 'b', description: 'b', status: 'running', logs: [] },
        { id: 's2', name: 'c', description: 'c', status: 'pending', logs: [] },
      ],
    })
    const cp = {
      activeRuns: [legacyRun],
      waitingRuns: {},
      savedAt: '2026-09-05T00:05:00.000Z',
      // 无 runDefs：模拟 legacy pre-L2 localStorage checkpoint
    }
    h.dbMap.set('cp', JSON.stringify(cp))

    await useWorkflowStore.getState().restoreCheckpoint()
    const run = useWorkflowStore.getState().activeRuns.find((r) => r.id === 'run-legacy-missing')
    expect(run?.status).toBe('paused') // running 走兜底 → paused，而非误路由自动重放
    expect(h.seen).toEqual([]) // 未被重放（不重新生成内容）
  })

  it('legacy checkpoint（runDefs 缺失）novel_import → 不调工厂不抛 TypeError，整批 restore 正常 resolve', async () => {
    // 复现真实 novel_import 工厂：params.chapters 缺失会抛（String(params.chapters.length) → undefined）
    registerWorkflow('novel_import', (p) => {
      if (!p.chapters) throw new TypeError('chapters undefined')
      return { type: 'novel_import', title: '导入', steps: [] }
    })
    const legacyRun = makeRun('run-import', {
      type: 'novel_import' as const,
      status: 'running',
      currentStepIndex: 0,
      steps: [{ id: 'i-s0', name: 'a', description: 'a', status: 'completed', result: 'a', logs: [] }],
    })
    const cp = {
      activeRuns: [legacyRun],
      waitingRuns: {},
      savedAt: '2026-09-05T00:06:00.000Z',
      // 无 runDefs
    }
    h.dbMap.set('cp', JSON.stringify(cp))

    // runDefs 缺失 → 不得调用工厂（否则 TypeError）→ 整批 restore 必须 resolve（不 reject）+ 走兜底
    await expect(useWorkflowStore.getState().restoreCheckpoint()).resolves.not.toBeNull()
    const run = useWorkflowStore.getState().activeRuns.find((r) => r.id === 'run-import')
    expect(run?.status).toBe('paused')
    expect(h.seen).toEqual([])
  })

  it('running 重放 startIndex>=steps.length（末步已完成与 run 完成间崩溃）→ completed 不 stuck running', async () => {
    // post_process 定义 3 步（a/b/c）；run 已完成全部步骤（currentStepIndex=3 >= steps.length=3）。
    // 先入列（set activeRuns）再 fire executeRunFromIndex → 零迭代同步完成，finalRun 命中 → completed 入历史。
    const finishedRun = makeRun('run-done', {
      status: 'running',
      currentStepIndex: 3,
      steps: [
        { id: 's0', name: 'a', description: 'a', status: 'completed', result: 'a', logs: [] },
        { id: 's1', name: 'b', description: 'b', status: 'completed', result: 'b', logs: [] },
        { id: 's2', name: 'c', description: 'c', status: 'completed', result: 'c', logs: [] },
      ],
    })
    const cp = {
      activeRuns: [finishedRun],
      waitingRuns: {},
      savedAt: '2026-09-05T00:07:00.000Z',
      runDefs: { 'run-done': { type: 'post_process', params: { seed: 'run-done' } } },
    }
    h.dbMap.set('cp', JSON.stringify(cp))

    await useWorkflowStore.getState().restoreCheckpoint()
    await waitFor(() => useWorkflowStore.getState().history.some((r) => r.id === 'run-done'))
    const finalRun = useWorkflowStore.getState().history.find((r) => r.id === 'run-done')
    expect(finalRun?.status).toBe('completed')
    // 不再 stuck running：activeRuns 不残留该 run
    expect(useWorkflowStore.getState().activeRuns.some((r) => r.id === 'run-done')).toBe(false)
    // 零迭代重跑：无步骤被执行
    expect(h.seen).toEqual([])
  })
})
