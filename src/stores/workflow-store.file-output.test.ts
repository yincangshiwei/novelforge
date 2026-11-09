// @vitest-environment jsdom
/**
 * workflow-store × 输出落盘（M2，CC §三.4 双轨）：
 * - 流式镜像：appendText 经既有 100ms 共享 flush 汇聚点同步镜像到主进程文件
 *   （fs:workflow-output-append），内存 step.result 行为零变化（双轨兼容）；
 * - 任务级清理：正常终态可靠保存后 delete-run；取消时保留输出供恢复；
 * - 崩溃恢复续读：restoreCheckpoint 后 hydrateInterruptedOutputs 把中断步骤落盘
 *   输出（full tail 文件）补回空的 step.result（checkpoint 已有内容零改动，
 *   补填内容走 cleanupMessageText 净化）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useWorkflowStore, type WorkflowDefinition, type WorkflowStep, type StepStatus } from './workflow-store'

type InvokeCall = { channel: string; args: unknown[] }
const invokeCalls: InvokeCall[] = []

/** tail 桩内容（按 runId:stepIndex 返回；默认存在且返回一段文本） */
const tailFixture = new Map<string, { content: string; exists?: boolean }>()

beforeEach(() => {
  invokeCalls.length = 0
  tailFixture.clear()
  Object.defineProperty(window, 'velaAPI', {
    value: {
      invoke: async (channel: string, ...args: unknown[]) => {
        invokeCalls.push({ channel, args })
        if (channel === 'fs:workflow-output-tail') {
          const [runId, stepIndex] = args as [string, number]
          const f = tailFixture.get(`${runId}:${stepIndex}`)
          if (f) {
            return { success: true, exists: f.exists !== false, content: f.content, totalBytes: Buffer.byteLength(f.content), truncated: false }
          }
          return { success: true, exists: false, content: '', totalBytes: 0, truncated: false }
        }
        return { success: true }
      },
      on: () => () => {},
      once: () => {},
      send: () => {},
      setZoomLevel: () => {},
      setZoomFactor: () => {},
      getZoomLevel: () => 0,
    },
    configurable: true,
  })
})

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

afterEach(() => {
  resetStore()
  localStorage.clear()
})

/** 断言调用序列中是否出现过某通道（按通道名 + 前导参数） */
function findCall(channel: string, fromIndex = 0): InvokeCall | undefined {
  return invokeCalls.slice(fromIndex).find(c => c.channel === channel)
}

describe('流式镜像（双轨：内存 step.result 不变 + 文件镜像同文本）', () => {
  it('appendText 汇聚 flush 后镜像到文件（fs:workflow-output-append），内存 result 逐字保留', async () => {
    const definition: WorkflowDefinition = {
      type: 'chapter_creation',
      title: '第 1 章创作',
      steps: [
        {
          name: '写稿',
          description: '',
          executor: async (_step, _ctx, callbacks) => {
            callbacks.appendText('第一段正文')
            callbacks.appendText('第二段正文')
            return undefined
          },
        },
      ],
    }
    const runId = await useWorkflowStore.getState().startWorkflow(definition)

    // 步骤完成 → flushAppendTextNow 立即写内存 + 镜像（无 100ms 等待）
    const appendCall = findCall('fs:workflow-output-append')
    expect(appendCall).toBeTruthy()
    expect(appendCall!.args).toEqual([runId, 0, '第一段正文第二段正文'])

    // 双轨兼容：内存 step.result 与现状一致（accumulated + 无覆盖）
    const run = useWorkflowStore.getState().history.find(r => r.id === runId)
    expect(run).toBeTruthy()
    expect(run!.steps[0]!.result).toBe('第一段正文第二段正文')
    expect(run!.steps[0]!.status).toBe('completed')

    // 任务级清理：run 移入历史后 delete-run
    const deleteCall = findCall('fs:workflow-output-delete-run')
    expect(deleteCall).toBeTruthy()
    expect(deleteCall!.args).toEqual([runId])
    expect(useWorkflowStore.getState().activeRuns).toHaveLength(0)
  })

  it('executor 返回最终文本时（流式后清洗），镜像仍=流式原文、result=返回值（既有语义不回归）', async () => {
    const definition: WorkflowDefinition = {
      type: 'chapter_creation',
      title: '第 1 章创作',
      steps: [
        {
          name: '写稿',
          description: '',
          executor: async (_step, _ctx, callbacks) => {
            callbacks.appendText('原始流式<think>半截')
            return '清洗后完整正文'
          },
        },
      ],
    }
    const runId = await useWorkflowStore.getState().startWorkflow(definition)
    const appendCall = findCall('fs:workflow-output-append')
    expect(appendCall!.args).toEqual([runId, 0, '原始流式<think>半截'])
    const run = useWorkflowStore.getState().history.find(r => r.id === runId)
    expect(run!.steps[0]!.result).toBe('清洗后完整正文')
  })

  it('取消工作流保留恢复输出，历史记录可靠保存后仍不删除', async () => {
    let ready!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => { ready = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const running = useWorkflowStore.getState().startWorkflow({
      type: 'chapter_creation', title: '取消测试', steps: [{ name: '写稿', description: '',
        executor: async (_step, _ctx, callbacks) => {
          callbacks.appendText('取消前缓冲正文')
          ready()
          await gate
        },
      }],
    })
    await started
    const runId = useWorkflowStore.getState().activeRuns[0].id
    useWorkflowStore.getState().cancelWorkflow(runId)
    release()
    await running
    expect(await useWorkflowStore.getState().flushCheckpoint()).toBe(true)
    expect(findCall('fs:workflow-output-delete-run')).toBeUndefined()
    const run = useWorkflowStore.getState().history.find(r => r.id === runId)!
    expect(run.status).toBe('failed')
    expect(run.steps[0].result).toBe('取消前缓冲正文')
    expect(findCall('fs:workflow-output-append')!.args).toEqual([runId, 0, '取消前缓冲正文'])
  })
})

describe('崩溃恢复续读（hydrateInterruptedOutputs）', () => {
  const checkpointStep = (id: string, over: Partial<WorkflowStep> = {}): WorkflowStep => ({
    id,
    name: `步骤-${id}`,
    description: '',
    status: 'pending' as StepStatus,
    logs: [],
    ...over,
  })

  it('恢复的 paused run：result 为空的运行中步骤从文件补回（cleanupMessageText 净化）', async () => {
    const fileContent = '半截正文<think>流式中断'
    tailFixture.set('run-crash:0', { content: fileContent })

    useWorkflowStore.setState({
      activeRuns: [{
        id: 'run-crash',
        type: 'chapter_creation',
        title: '崩溃恢复',
        status: 'paused',
        currentStepIndex: 0,
        createdAt: '2026-09-01T00:00:00.000Z',
        steps: [
          checkpointStep('s1', { status: 'running', startedAt: '2026-09-01T00:00:01.000Z' }),
        ],
      }],
    })

    await useWorkflowStore.getState().hydrateInterruptedOutputs()

    const run = useWorkflowStore.getState().activeRuns.find(r => r.id === 'run-crash')
    expect(run!.steps[0]!.result).toBe('半截正文')
    // 续读不触发删除（文件保留至用户取消）
    expect(findCall('fs:workflow-output-delete-run')).toBeUndefined()
  })

  it('checkpoint 已有内容的步骤零改动（文件更"长"也不覆盖——已完成内容以内存/checkpoint 为准）', async () => {
    tailFixture.set('run-b:0', { content: '文件里的另一版本全文……' })
    useWorkflowStore.setState({
      activeRuns: [{
        id: 'run-b',
        type: 'chapter_creation',
        title: '有内容恢复',
        status: 'paused',
        currentStepIndex: 0,
        createdAt: '2026-09-01T00:00:00.000Z',
        steps: [
          checkpointStep('s1', { status: 'completed', result: '已完成步骤正文（checkpoint）' }),
        ],
      }],
    })
    await useWorkflowStore.getState().hydrateInterruptedOutputs()
    const run = useWorkflowStore.getState().activeRuns.find(r => r.id === 'run-b')
    expect(run!.steps[0]!.result).toBe('已完成步骤正文（checkpoint）')
  })

  it('running（未崩溃）run 不参与续读；文件不存在则不动', async () => {
    tailFixture.set('run-live:0', { content: '不应被读的内容' })
    useWorkflowStore.setState({
      activeRuns: [
        {
          id: 'run-live',
          type: 'chapter_creation',
          title: '运行中',
          status: 'running',
          currentStepIndex: 0,
          createdAt: '2026-09-01T00:00:00.000Z',
          steps: [checkpointStep('s1', { status: 'running' })],
        },
        {
          id: 'run-no-file',
          type: 'chapter_creation',
          title: '无文件',
          status: 'paused',
          currentStepIndex: 0,
          createdAt: '2026-09-01T00:00:00.000Z',
          steps: [checkpointStep('s2', { status: 'running' })],
        },
      ],
    })
    await useWorkflowStore.getState().hydrateInterruptedOutputs()
    const live = useWorkflowStore.getState().activeRuns.find(r => r.id === 'run-live')
    expect(live!.steps[0]!.result).toBeUndefined()
    const noFile = useWorkflowStore.getState().activeRuns.find(r => r.id === 'run-no-file')
    expect(noFile!.steps[0]!.result).toBeUndefined()
    // 只对 paused run 发起过 tail 读取（run-live 未被读取）
    expect(invokeCalls.filter(c => c.channel === 'fs:workflow-output-tail').map(c => (c.args[0] as string))).toEqual(['run-no-file'])
  })
})
