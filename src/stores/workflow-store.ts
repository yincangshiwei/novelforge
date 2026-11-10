import { create } from 'zustand'
import { getCurrentLocale, t } from '../shared/locale'
import { randomUUID } from '../utils/id'
import { useProjectStore } from './project-store'
import { renderLog } from '../services/render-logger'
import { toast } from '../components/ui/Toast'
import { ipc } from '../services/ipc-client'
import { drainLLMRequests } from '../services/llm/request-drain'
import { CLOSE_DRAIN_TIMEOUT_MS, waitForCloseResult } from '../shared/close-deadline'
import { isCloseCoordinating } from '../shared/close-coordinator'
import { sanitizeCheckpointData, cleanupMessageText } from '../services/agent/conversation-recovery'
import { mirrorStepAppend, deleteRunOutput, readStepOutputTail } from '../services/workflow-output'

// ===== 工作流 Checkpoint 持久化 =====

const CHECKPOINT_KEY = 'vela-workflow-checkpoint'

/** Checkpoint 数据结构（导出：conversation-recovery 净化纯函数复用类型，L2 迁 DB 亦复用） */
export interface CheckpointData {
  activeRuns: WorkflowRun[]
  history?: WorkflowRun[]
  waitingRuns: Record<string, { waitingForConfirm: boolean; waitingAfterStepIndex: number }>
  savedAt: string
  /** runId → 重建信息（type + params 快照）；L2 迁 DB 起持久化，供 rehydrateWorkflow 重建 definition */
  runDefs?: Record<string, { type: WorkflowType; params: WorkflowParams }>
  /** runId → context.data 快照（executor 跨步骤共享数据；无则省略） */
  contextData?: Record<string, Record<string, unknown>>
}

let checkpointTail: Promise<void> = Promise.resolve()
let checkpointError: unknown

async function saveCheckpoint(state: WorkflowState, required = false): Promise<void> {
  try {
    const active = state.activeRuns.filter(r => r.status === 'running' || r.status === 'waiting' || r.status === 'paused')
    const data: CheckpointData = {
      activeRuns: active,
      history: state.history.slice(0, 50),
      waitingRuns: state.waitingRuns,
      savedAt: new Date().toISOString(),
      runDefs: Object.fromEntries(
        active.map((r): [string, { type: WorkflowType; params: WorkflowParams }] => [
          r.id,
          runDefs.get(r.id) ?? { type: r.type, params: (r as WorkflowRun & { rehydrateParams?: WorkflowParams }).rehydrateParams ?? {} },
        ]),
      ),
      contextData: Object.fromEntries(
        active.map((r): [string, Record<string, unknown>] => [
          r.id, activeContexts.get(r.id)?.data ?? resumeContextData.get(r.id) ?? {},
        ]),
      ),
    }
    const snapshot = JSON.parse(JSON.stringify(data)) as CheckpointData
    const write = checkpointTail.then(async () => {
      const result = active.length > 0 || state.history.length > 0
        ? await ipc.invoke('db:checkpoint-save', snapshot)
        : await ipc.invoke('db:checkpoint-clear')
      if (result?.success !== true) throw new Error('工作流执行记录保存失败')
      checkpointError = undefined
    })
    checkpointTail = write.catch(error => { checkpointError = error })
    await write
  } catch (error) {
    checkpointError = error
    renderLog('error', 'Workflow', `工作流执行记录保存失败：${String(error)}`)
    try {
      toast.error('工作流执行记录保存失败，请勿关闭应用；可重试保存。')
    } catch (notificationError) {
      renderLog('error', 'Workflow', `保存失败通知异常：${String(notificationError)}`)
    }
    if (required) throw error
  }
}

async function loadCheckpoint(): Promise<CheckpointData | null> {
  try {
    const res = await ipc.invoke('db:checkpoint-load') as { data?: unknown }
    if (res.data) return sanitizeCheckpointData(res.data)
    // 兜底：DB 空 → 读旧 localStorage（存量迁移，L2 迁 DB 前的旧数据仍可恢复）
    try {
      const raw = localStorage.getItem(CHECKPOINT_KEY)
      if (raw) {
        const legacy = sanitizeCheckpointData(JSON.parse(raw))
        if (legacy && legacy.activeRuns.length > 0) void ipc.invoke('db:checkpoint-save', legacy).catch(() => {})
        return legacy
      }
    } catch { /* ignore */ }
    return null
  } catch {
    return null
  }
}

function clearCheckpoint(): void {
  try { localStorage.removeItem(CHECKPOINT_KEY) } catch { /* ignore */ }
  try { void ipc.invoke('db:checkpoint-clear').catch(() => {}) } catch { /* ignore */ }
}

// ===== 工作流数据模型 =====

/** 工作流步骤状态 */
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

/** 工作流运行状态 */
export type WorkflowStatus = 'idle' | 'running' | 'completed' | 'failed' | 'paused' | 'waiting'

/** 工作流步骤 */
export interface WorkflowStep {
  id: string
  name: string
  description: string
  status: StepStatus
  progress?: number
  result?: string
  error?: string
  startedAt?: string
  completedAt?: string
  logs: string[]
  /** 允许命令注入额外属性（如 commandId, params 等） */
  [extra: string]: unknown
}

/** 工作流运行实例 */
export interface WorkflowRun {
  id: string
  type: WorkflowType
  title: string
  status: WorkflowStatus
  steps: WorkflowStep[]
  currentStepIndex: number
  createdAt: string
  completedAt?: string
  /** L2：可重建参数快照（rehydrateParams；Task 5 save 消费；confirmContinue 跨重启重放读） */
  rehydrateParams?: WorkflowParams
  operationId?: string
  scope?: string
  /** 启动意图先落盘；尚未执行的意图恢复后不自动运行。 */
  startupState?: 'intent' | 'started' | 'cancelled' | 'failed'
  cancellationRequestedAt?: string
  pauseRequested?: boolean
  stepByStep?: boolean
  resumeData?: Record<string, unknown>
}

export interface WorkflowStartOptions {
  headless?: boolean
  onStarted?: (runId: string) => void
  signal?: AbortSignal
  operationId?: string
  scope?: string
  beforeStart?: () => void | Promise<void>
}

/** 工作流类型 */
export type WorkflowType =
  | 'new_project_setup'       // 新项目初始化（配置→架构→目录）
  | 'architecture_generation' // 架构生成（故事前提→角色图谱→世界观→情节大纲）
  | 'directory'               // 目录/蓝图生成
  | 'chapter_creation'        // 章节创作（写稿→修稿→审稿→定稿）
  | 'book_pipeline'           // 整本流水线（逐章写稿→自审→定稿→索引/记忆）
  | 'batch_generate'          // 批量生成
  | 'config_generation'       // 智能配置生成
  | 'post_process'            // 后处理任务（角色卡提取等）
  | 'novel_import'            // 导入已有小说（逆向推演全流程）

/** 工作流步骤执行器 */
export type StepExecutor = (
  step: WorkflowStep,
  context: WorkflowContext,
  callbacks: StepCallbacks,
) => Promise<string | void>

/** 工作流上下文（共享数据） */
export interface WorkflowContext {
  /** 步骤间传递的数据 */
  data: Record<string, unknown>
  /** 是否已取消 */
  cancelled: boolean
  signal?: AbortSignal
  checkpoint?: () => Promise<void>
}

/** 步骤回调 */
export interface StepCallbacks {
  /** 追加日志 */
  log: (message: string) => void
  /** 更新进度 (0-100) */
  setProgress: (progress: number) => void
  /** 流式文本追加 */
  appendText: (text: string) => void
}

// ===== 工作流定义 =====

/** 工作流完成后的通知/跳转动作 */
export interface WorkflowCompleteAction {
  /** 通知策略：open=直接打开 | silent=仅内部状态不额外动作 */
  mode: 'open' | 'silent'
  /** 成功时的提示文案（备用，供日志用） */
  message?: string
  /** 打开结果的回调（open 模式直接调用） */
  openResult?: () => void | Promise<void>
}

export type WorkflowParams = Record<string, unknown>

export interface WorkflowDefinition {
  type: WorkflowType
  title: string
  steps: Array<{
    name: string
    description: string
    executor: StepExecutor
  }>
  /** 工作流完成后的通知/跳转动作（可选） */
  onComplete?: WorkflowCompleteAction
  /** L2：可重建参数快照（type + 此 params → rehydrateWorkflow 重建定义；零改动调用点，方案 ii） */
  rehydrateParams?: WorkflowParams
}

// ===== Store =====

interface WorkflowState {
  /** 所有活跃的工作流（支持多任务并发） */
  activeRuns: WorkflowRun[]
  /** 历史工作流记录 */
  history: WorkflowRun[]
  /** 全局日志（下方面板用） */
  globalLogs: Array<{ ts: number; time: string; level: 'info' | 'warn' | 'error'; message: string }>

  /** 兼容属性：第一个活跃工作流（供旧代码平稳过渡） */
  currentRun: WorkflowRun | null

  /** 步进模式：各工作流的等待状态 */
  waitingRuns: Record<string, { waitingForConfirm: boolean; waitingAfterStepIndex: number }>

  // ===== 旧接口兼容（映射到第一个 activeRun） =====
  waitingForConfirm: boolean
  waitingAfterStepIndex: number

  selectedRunId: string | null
  selectRun: (runId: string | null) => void
  resetProject: () => void

  // ===== 便捷查询 =====
  /** 检查指定类型的工作流是否有在运行 */
  isTypeRunning: (type: WorkflowType) => boolean
  /** 是否有任何工作流在运行 */
  hasActiveRun: () => boolean
  /** 活跃任务数量 */
  activeCount: () => number
  /** 获取当前正在流式输出的活跃工作流（供 AI 输出面板消费） */
  getActiveStreamingRun: () => WorkflowRun | null
  /** 获取当前最活跃任务的步骤信息（供 StatusBar 胶囊显示） */
  getActiveStepInfo: () => { title: string; stepName: string; progress: number; total: number; completed: number } | null

  // ===== Actions =====
  /** 启动一个工作流（可并发），返回 runId */
  startWorkflow: (definition: WorkflowDefinition, stepByStep?: boolean, options?: WorkflowStartOptions) => Promise<string>
  /** 步进模式下确认继续执行下一步（需指定 runId） */
  confirmContinue: (runId?: string) => void
  /** 取消工作流（传 runId 取消指定，不传取消全部） */
  cancelWorkflow: (runId?: string) => void
  pauseWorkflow: (runId: string) => void
  restartWorkflow: (runId: string) => Promise<void>
  continueDirectory: (runId: string) => Promise<void>
  deleteHistory: (runId: string) => Promise<void>
  flushCheckpoint: () => Promise<boolean>
  prepareForClose: () => Promise<boolean>
  /** 添加全局日志 */
  addLog: (level: 'info' | 'warn' | 'error', message: string) => void
  /** 清空日志 */
  clearLogs: () => void
  /** 从 checkpoint 恢复未完成的工作流（应用启动时调用；L2 v2：rehydrate 重建 + 断点重放决断） */
  restoreCheckpoint: () => Promise<CheckpointData | null>
  /** 清除持久化的 checkpoint */
  clearCheckpoint: () => void
  /**
   * 崩溃恢复续读（M2，CC §三.4）：restoreCheckpoint 后调用——把中断步骤落盘到
   * workflow-output/<runId>/<stepIndex>.txt 的输出（主进程文件）补回空的 step.result。
   * 只补「result 为空且文件存在」的步骤（checkpoint 已有内容/正常步骤零改动），
   * 补填内容走 cleanupMessageText 净化（与 checkpoint 恢复同语义，防半截 think 残片）。
   */
  hydrateInterruptedOutputs: () => Promise<void>
}

/** 工作流上下文实例 Map（runId → context） */
const activeContexts = new Map<string, WorkflowContext>()
const runControllers = new Map<string, AbortController>()
const runExecutions = new Map<string, Promise<void>>()
const resumingRuns = new Set<string>()
/** 步进模式：存储「等待用户确认」的 Promise resolve（runId → resolve） */
const continueResolveRefs = new Map<string, () => void>()
/** L2：run 可重建参数快照（type + params → rehydrateWorkflow；Task 5 saveCheckpoint 消费，本任务先引入） */
const runDefs = new Map<string, { type: WorkflowType; params: WorkflowParams }>()
/** L2 v2（IMP-1）：跨重启 waiting 续跑的断点上下文——restoreCheckpoint 时从 checkpoint contextData 快照；
 *  waiting run 恢复时无 activeContexts 条目，confirmContinue 重放用它恢复 ctx.data（否则 ?? {} 恒为空丢共享数据）。 */
const resumeContextData = new Map<string, Record<string, unknown>>()
const startupReceipts = new Map<string, Promise<string>>()

function checkStartSignal(options?: WorkflowStartOptions): void {
  if (options?.signal?.aborted || (options?.scope !== undefined && options.scope !== useProjectStore.getState().currentProject?.path)) {
    throw new DOMException('工作流启动已取消或项目已切换', 'AbortError')
  }
}

export function findWorkflowOperation(operationId: string, scope?: string): WorkflowRun | undefined {
  const state = useWorkflowStore.getState()
  return [...state.activeRuns, ...state.history].find(run => run.operationId === operationId && run.scope === scope)
}

// ===== appendText 流式缓冲（共享限频调度器） =====
// LLM 流式 chunk 逐片 setState 会高频重渲染整个面板，阻塞主线程。
// 后果：mouseover 事件排队 → 浏览器原生 title 提示（UI 线程驱动，不受 JS 阻塞）
// 抢先弹出，用户看到"旧样式"悬浮弹窗。
//
// 根因教训（44244a1 修复无效的原因）：旧的"按 buffer 大小 >=200 立即 flush"会绕过
// 定时器——chunk 大或快时 flush 频率仍 ≈ chunk 频率；且定稿后处理 6-7 个步骤并发
// 流式，各自独立 buffer/timer，setState 频率再 ×并发数 → 主线程照样被占。
//
// 正确做法：**单一共享 timer 驱动，所有 run/step 的文本先进 pending 队列**。
// 最小刷新间隔 = FLUSH_INTERVAL_MS 是硬约束（并发步骤共用一个 timer，每轮最多
// 一次渲染）；同 tick 内的多次 updateStepById 被 React 自动批处理为一次渲染。
const FLUSH_INTERVAL_MS = 100
const pendingAppendFlushes = new Map<string, string>()
let appendFlushScheduled = false

/** 安排下一轮统一 flush（模块级单 timer，所有并发步骤共享） */
function scheduleAppendFlush(): void {
  if (appendFlushScheduled) return
  appendFlushScheduled = true
  setTimeout(() => {
    appendFlushScheduled = false
    flushAllPendingAppends()
  }, FLUSH_INTERVAL_MS)
}

/**
 * 把当前步骤的累积文本写入步骤 result。
 * key 格式：`{runId}:{stepIndex}`
 *
 * M2 双轨：此处是「内存流式 + 文件镜像」的单一汇聚点——文本以既有 100ms 共享 flush 节奏
 * 同时进 step.result（UI 流式渲染）与主进程输出文件（崩溃恢复/续读，见 workflow-output）。
 * 镜像与内存写同频、fire-and-forget，失败静默（补充通道，绝不打断渲染主路径）。
 */
function writeStepResultAppend(key: string, text: string): void {
  const sepIdx = key.indexOf(':')
  if (sepIdx < 0) return
  const runId = key.slice(0, sepIdx)
  const stepIndex = parseInt(key.slice(sepIdx + 1), 10)
  if (isNaN(stepIndex)) return

  const state = useWorkflowStore.getState()
  const activeRun = [...state.activeRuns, ...state.history].find(r => r.id === runId)
  if (!activeRun) return
  const step = activeRun.steps[stepIndex]
  if (!step) return
  updateStepById(useWorkflowStore.setState, runId, stepIndex, { result: (step.result || '') + text })
  mirrorStepAppend(runId, stepIndex, text)
}

/** 定时器到期：把 pending 队列中全部累积文本一次性写入（多 key 同 tick → 一次渲染） */
function flushAllPendingAppends(): void {
  if (pendingAppendFlushes.size === 0) return
  for (const [key, text] of pendingAppendFlushes) {
    pendingAppendFlushes.delete(key)
    writeStepResultAppend(key, text)
  }
}

/**
 * 立即写入指定 key 的残留缓冲（不等 timer）。
 * 用于步骤完成/工作流结束时——此后该 key 不会再有新 chunk。
 */
function flushAppendTextNow(key: string): void {
  const text = pendingAppendFlushes.get(key)
  if (text === undefined) return
  pendingAppendFlushes.delete(key)
  writeStepResultAppend(key, text)
}

/** 清理某工作流的所有待写缓冲（结束/取消时丢弃残留，不写入） */
function clearAppendBuffers(runId: string): void {
  for (const key of [...pendingAppendFlushes.keys()]) {
    if (key.startsWith(`${runId}:`)) pendingAppendFlushes.delete(key)
  }
}

/** 计算兼容字段的辅助函数 */
function computeCompat(activeRuns: WorkflowRun[], waitingRuns: Record<string, { waitingForConfirm: boolean; waitingAfterStepIndex: number }>) {
  const currentRun = activeRuns.length > 0 ? activeRuns[0] : null
  const firstRunId = currentRun?.id ?? ''
  const firstWaiting = waitingRuns[firstRunId]
  return {
    currentRun,
    waitingForConfirm: firstWaiting?.waitingForConfirm ?? false,
    waitingAfterStepIndex: firstWaiting?.waitingAfterStepIndex ?? -1,
  }
}

export const useWorkflowStore = create<WorkflowState>()((set, get) => ({
  activeRuns: [],
  history: [],
  globalLogs: [],
  waitingRuns: {},
  selectedRunId: null,
  selectRun: (runId) => set({ selectedRunId: runId }),
  resetProject: () => {
    if (get().activeRuns.length > 0 || runExecutions.size > 0 || startupReceipts.size > 0) throw new Error(t('workflow.projectBusy'))
    runDefs.clear()
    resumeContextData.clear()
    set({ activeRuns: [], history: [], globalLogs: [], waitingRuns: {}, selectedRunId: null, ...computeCompat([], {}) })
  },

  // 兼容属性初始值
  currentRun: null,
  waitingForConfirm: false,
  waitingAfterStepIndex: -1,

  // ===== 便捷查询 =====
  isTypeRunning: (type) => get().activeRuns.some(r => r.type === type && (r.status === 'running' || r.status === 'waiting')),
  hasActiveRun: () => get().activeRuns.length > 0,
  activeCount: () => get().activeRuns.length,

  getActiveStreamingRun: () => {
    const runs = get().activeRuns
    // 优先返回正在 running 的任务；其次 waiting 的
    return runs.find(r => r.status === 'running') || runs.find(r => r.status === 'waiting') || null
  },

  getActiveStepInfo: () => {
    const run = get().activeRuns.find(r => r.status === 'running' || r.status === 'waiting')
    if (!run) return null
    const step = run.steps[run.currentStepIndex] || run.steps[0]
    const completed = run.steps.filter(s => s.status === 'completed').length
    return {
      title: run.title,
      stepName: step?.name || '',
      progress: step?.progress || 0,
      total: run.steps.length,
      completed,
    }
  },

  confirmContinue: (runId) => {
    // 如果未指定 runId，使用第一个等待中的
    const targetId = runId ?? Object.keys(get().waitingRuns).find(id => get().waitingRuns[id]?.waitingForConfirm)
    if (!targetId || closingWorkflows || resumingRuns.has(targetId)) return
    const paused = get().activeRuns.find(r => r.id === targetId && r.status === 'paused')
    if (paused) {
      resumingRuns.add(targetId)
      void (async () => {
        await runExecutions.get(targetId)
        const current = get().activeRuns.find(r => r.id === targetId)
        if (!current || current.cancellationRequestedAt || closingWorkflows) return
        const m = await import('../services/workflows/workflow-registry')
        const def = m.rehydrateWorkflow(current.type, current.rehydrateParams ?? {})
        if (!def) throw new Error('无法恢复此工作流，请重新生成')
        updateRunById(set, targetId, { pauseRequested: false })
        const waitIndex = get().waitingRuns[targetId]?.waitingAfterStepIndex
        set(s => {
          const waitingRuns = { ...s.waitingRuns }
          delete waitingRuns[targetId]
          return { waitingRuns, ...computeCompat(s.activeRuns, waitingRuns) }
        })
        await executeRunFromIndex({ ...current, pauseRequested: false }, def,
          waitIndex === undefined ? current.currentStepIndex : waitIndex + 1,
          resumeContextData.get(targetId) ?? {}, current.stepByStep)
      })().catch(error => toast.error(String(error))).finally(() => resumingRuns.delete(targetId))
      return
    }
    const resolve = continueResolveRefs.get(targetId)
    if (resolve) {
      // 进程内步进等待：内存 resolve（现状语义不变），continueResolveRefs 保持进程内语义
      resolve()
      continueResolveRefs.delete(targetId)
    } else {
      // L2：跨重启恢复后 waiting 无内存 resolve → 用断点重放续跑
      // （动态 import 规避 store←→registry 静态循环；rehydrateWorkflow 按 run 参数重建定义）
      const r = get().activeRuns.find(x => x.id === targetId)
      if (r) {
        // 断点 index 须在下方同步删除 waitingRuns 标记前捕获——否则异步 import 完成后
        // 读到已被删除的标记 → waitIdx=-1 → 从 index 0 重放（断点重放打不到正确位置）。
        const waitIdx = get().waitingRuns[targetId]?.waitingAfterStepIndex ?? -1
        import('../services/workflows/workflow-registry').then(async m => {
          const def = m.rehydrateWorkflow(r.type, r.rehydrateParams ?? {})
          if (def) {
            // IMP-1：跨重启 waiting 续跑无 activeContexts 条目 → 用 restoreCheckpoint 快照的
            // resumeContextData 恢复 ctx.data（checkpoint contextData 保存的跨步共享数据）。
            await executeRunFromIndex(r, def, waitIdx + 1, activeContexts.get(targetId)?.data ?? resumeContextData.get(targetId) ?? {})
          }
        }).catch(() => {})
      }
    }
    set(s => {
      const newWaiting = { ...s.waitingRuns }
      delete newWaiting[targetId]
      const compat = computeCompat(s.activeRuns, newWaiting)
      return { waitingRuns: newWaiting, ...compat }
    })
  },

  startWorkflow: async (definition, stepByStep = false, options) => {
    if (closingWorkflows || isCloseCoordinating()) throw new Error('正在保存退出，不启动新工作流')
    checkStartSignal(options)
    if (definition.type === 'directory' && (get().activeRuns.some(r => r.type === 'directory')
      || [...runExecutions.keys()].some(id => get().history.some(r => r.id === id && r.type === 'directory')))) {
      throw new Error('已有蓝图任务或请求正在收尾，请继续、终止或等待它停止后再生成')
    }
    const operationKey = options?.operationId ? JSON.stringify([options.scope, options.operationId]) : undefined
    if (operationKey) {
      const pendingReceipt = startupReceipts.get(operationKey)
      if (pendingReceipt) {
        const id = await pendingReceipt
        checkStartSignal(options)
        options?.onStarted?.(id)
        return id
      }
      const existing = findWorkflowOperation(options!.operationId!, options?.scope)
      if (existing) {
        if (existing.startupState === 'intent' || existing.startupState === 'cancelled' || existing.startupState === 'failed') {
          throw new Error(`工作流已有未执行或失败的启动记录：${existing.id}`)
        }
        options?.onStarted?.(existing.id)
        return existing.id
      }
    }
    let resolveReceipt: (id: string) => void = () => {}
    let rejectReceipt: (error: unknown) => void = () => {}
    const startupKey = operationKey ?? randomUUID()
    const receipt = new Promise<string>((resolve, reject) => { resolveReceipt = resolve; rejectReceipt = reject })
    void receipt.catch(() => {})
    startupReceipts.set(startupKey, receipt)
    const run: WorkflowRun = {
      id: randomUUID(),
      type: definition.type,
      title: definition.title,
      status: 'running',
      currentStepIndex: 0,
      createdAt: new Date().toISOString(),
      steps: definition.steps.map((s) => ({
        id: randomUUID(),
        name: s.name,
        description: s.description,
        status: 'pending',
        logs: [],
      })),
      rehydrateParams: definition.rehydrateParams ?? {},
      stepByStep,
      operationId: options?.operationId,
      scope: options?.scope,
      startupState: 'intent',
    }

    // 添加到活跃列表
    set(s => {
      const newRuns = [...s.activeRuns, run]
      return { activeRuns: newRuns, ...computeCompat(newRuns, s.waitingRuns) }
    })
    get().addLog('info', `[Start] ${definition.title}`)

    // 自动联动：打开底部任务面板（步进模式的"继续"确认按钮所在位置）+ 右侧 AI 输出视图
    // 非阻塞 import 避免循环依赖；不打开底栏时，步进模式下工作流会在等待确认时"隐形卡住"
    // headless（D 档自动化触发）：不抢焦点 —— 自动运行不该打断用户正在进行的编辑/阅读
    if (!options?.headless) {
      set({ selectedRunId: run.id })
      import('./layout-store').then(m => {
        m.useLayoutStore.getState().openBottomTab('tasks')
        m.useLayoutStore.getState().openRightPanel('ai-output')
      }).catch(() => {})
    }

    // 记录 run 可重建参数快照（Task 5 saveCheckpoint 消费；confirmContinue 跨重启重放读 run.rehydrateParams）
    runDefs.set(run.id, { type: run.type, params: definition.rehydrateParams ?? {} })

    try {
      checkStartSignal(options)
      await options?.beforeStart?.()
      checkStartSignal(options)
      await saveCheckpoint(get(), true)
      checkStartSignal(options)
      await options?.beforeStart?.()
      checkStartSignal(options)
      updateRunById(set, run.id, { startupState: 'started' })
      await saveCheckpoint(get(), true)
      checkStartSignal(options)
      await options?.beforeStart?.()
      checkStartSignal(options)
      if (!get().activeRuns.some(r => r.id === run.id)) throw new DOMException('工作流启动已取消', 'AbortError')
    } catch (error) {
      updateRunById(set, run.id, { startupState: options?.signal?.aborted || (error instanceof Error && error.name === 'AbortError') ? 'cancelled' : 'failed' })
      get().cancelWorkflow(run.id)
      await saveCheckpoint(get())
      rejectReceipt(error)
      startupReceipts.delete(startupKey)
      throw error
    }

    const cancelParent = () => get().cancelWorkflow(run.id)
    options?.signal?.addEventListener('abort', cancelParent, { once: true })
    resolveReceipt(run.id)
    startupReceipts.delete(startupKey)
    try {
      options?.onStarted?.(run.id)
      await executeRunFromIndex(run, definition, 0, {}, stepByStep)
      return run.id
    } finally {
      options?.signal?.removeEventListener('abort', cancelParent)
    }
  },

  pauseWorkflow: (runId) => {
    const run = get().activeRuns.find(r => r.id === runId)
    if (!run || run.type !== 'directory' || run.status === 'paused') return
    flushAllPendingAppends()
    updateRunById(set, runId, { status: 'paused', pauseRequested: true })
    const ctx = activeContexts.get(runId)
    if (ctx) {
      resumeContextData.set(runId, ctx.data)
      ctx.cancelled = true
    }
    runControllers.get(runId)?.abort()
    continueResolveRefs.get(runId)?.()
    continueResolveRefs.delete(runId)
    void saveCheckpoint(get())
  },

  restartWorkflow: async (runId) => {
    const run = [...get().activeRuns, ...get().history].find(r => r.id === runId)
    if (!run || run.type !== 'directory') return
    const scope = useProjectStore.getState().currentProject?.path
    get().cancelWorkflow(runId)
    await runExecutions.get(runId)
    const m = await import('../services/workflows/workflow-registry')
    const def = m.rehydrateWorkflow('directory', { ...run.rehydrateParams, mode: 'full', continueSaved: false, startChapter: undefined, count: undefined })
    if (!def) throw new Error('无法重新生成蓝图')
    if (scope !== useProjectStore.getState().currentProject?.path) throw new Error('项目已切换，取消重新生成')
    await get().startWorkflow(def, run.stepByStep, { scope })
  },

  continueDirectory: async (runId) => {
    if (closingWorkflows || isCloseCoordinating() || resumingRuns.has(runId)) return
    const run = [...get().activeRuns, ...get().history].find(r => r.id === runId)
    if (!run || run.type !== 'directory' || run.status === 'completed') return
    const scope = useProjectStore.getState().currentProject?.path
    resumingRuns.add(runId)
    try {
      await runExecutions.get(runId)
      if (scope !== useProjectStore.getState().currentProject?.path) throw new Error('项目已切换，取消继续生成')
      if (get().activeRuns.some(r => r.type === 'directory' && r.id !== runId)) throw new Error('已有蓝图任务，请先停止该任务')
      const current = [...get().activeRuns, ...get().history].find(r => r.id === runId) ?? run
      const data = { ...(resumeContextData.get(runId) ?? current.resumeData ?? {}) }
      const directory = await import('../services/workflows/directory-workflow')
      const generationIndex = current.steps.length > 1 ? 1 : 0
      const output = await readStepOutputTail(runId, generationIndex, { full: true })
      const text = output.exists && output.content ? output.content : current.steps[generationIndex]?.result ?? ''
      const completeRows = text.split('\n').filter(line => /^\s*\|\s*\d+\s*\|/.test(line) && /\|\s*$/.test(line)).join('\n')
      const end = useProjectStore.getState().currentProject?.novelConfig.totalChapters ?? Number.MAX_SAFE_INTEGER
      const parsed = completeRows ? directory.parseTextBlueprints(completeRows, 1, end) : []
      const committed = new Map(((data.newBlueprints ?? []) as import('../services/workflows/directory-workflow').ChapterBlueprint[]).map(b => [b.chapterNumber, b]))
      for (const blueprint of parsed) committed.set(blueprint.chapterNumber, blueprint)
      data.newBlueprints = [...committed.values()].sort((a, b) => a.chapterNumber - b.chapterNumber)
      const m = await import('../services/workflows/workflow-registry')
      const def = m.rehydrateWorkflow('directory', { ...current.rehydrateParams, continueSaved: false })
      if (!def) throw new Error('无法继续生成蓝图')
      if (scope !== useProjectStore.getState().currentProject?.path) throw new Error('项目已切换，取消继续生成')
      if (parsed.length) await directory.saveAllBlueprints(parsed)
      const resumed: WorkflowRun = { ...current, status: 'paused', cancellationRequestedAt: undefined, completedAt: undefined, pauseRequested: false,
        resumeData: data, steps: current.steps.map((step, index) => index >= generationIndex ? { ...step, status: 'pending', error: undefined, completedAt: undefined } : step) }
      set(s => ({ activeRuns: [...s.activeRuns.filter(r => r.id !== runId), resumed], history: s.history.filter(r => r.id !== runId), selectedRunId: runId }))
      resumeContextData.set(runId, data)
      await saveCheckpoint(get(), true)
      await executeRunFromIndex(resumed, def, data.architecture ? generationIndex : 0, data, current.stepByStep)
    } finally { resumingRuns.delete(runId) }
  },

  cancelWorkflow: (runId) => {
    if (runId) {
      flushAllPendingAppends()
      // 取消指定工作流
      const ctx = activeContexts.get(runId)
      if (ctx) ctx.cancelled = true
      runControllers.get(runId)?.abort()
      // 如果在步进等待，解除 Promise
      const resolve = continueResolveRefs.get(runId)
      if (resolve) { resolve(); continueResolveRefs.delete(runId) }
      // 移入历史
      set(s => {
        const targetRun = s.activeRuns.find(r => r.id === runId)
        const newRuns = s.activeRuns.filter(r => r.id !== runId)
        const newWaiting = { ...s.waitingRuns }
        delete newWaiting[runId]
        const newHistory = targetRun
          ? [{ ...targetRun, resumeData: ctx?.data ?? targetRun.resumeData, status: 'failed' as const, cancellationRequestedAt: new Date().toISOString(), completedAt: new Date().toISOString() }, ...s.history].slice(0, 50)
          : s.history
        return {
          activeRuns: newRuns,
          history: newHistory,
          waitingRuns: newWaiting,
          ...computeCompat(newRuns, newWaiting),
        }
      })
      get().addLog('warn', '[Cancel] Workflow cancelled')
      clearAppendBuffers(runId)
      resumeContextData.delete(runId)
      // M2：取消 = 任务级清理（用户不再需要该任务输出；崩溃恢复窗口关闭）
      saveCheckpoint(get())
    } else {
      // 取消全部
      flushAllPendingAppends()
      for (const [id, ctx] of activeContexts) {
        ctx.cancelled = true
        runControllers.get(id)?.abort()
        const resolve = continueResolveRefs.get(id)
        if (resolve) { resolve(); continueResolveRefs.delete(id) }
      }
      set(s => {
        const cancelledRuns = s.activeRuns.map(r => ({
          ...r, status: 'failed' as const, cancellationRequestedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        }))
        return {
          activeRuns: [],
          waitingRuns: {},
          history: [...cancelledRuns, ...s.history].slice(0, 50),
          currentRun: null,
          waitingForConfirm: false,
          waitingAfterStepIndex: -1,
        }
      })
      get().addLog('warn', '[Cancel] All workflows cancelled')
      resumeContextData.clear()
      saveCheckpoint(get())
    }
  },

  flushCheckpoint: async () => {
    await checkpointTail
    try { await saveCheckpoint(get(), true) } catch { return false }
    return checkpointError === undefined
  },
  deleteHistory: async (runId) => {
    if (closingWorkflows || isCloseCoordinating() || get().activeRuns.some(r => r.id === runId)
      || runExecutions.has(runId) || resumingRuns.has(runId)) throw new Error('任务尚未停止或正在恢复，不能删除')
    const run = get().history.find(r => r.id === runId)
    if (!run) return
    resumingRuns.add(runId)
    const scope = useProjectStore.getState().currentProject?.path
    const selected = get().selectedRunId
    try {
      set(s => ({ history: s.history.filter(r => r.id !== runId), selectedRunId: s.selectedRunId === runId ? null : s.selectedRunId }))
      try { await saveCheckpoint(get(), true) } catch (error) {
        if (scope === useProjectStore.getState().currentProject?.path) {
          set(s => ({ history: [run, ...s.history.filter(r => r.id !== runId)], selectedRunId: selected }))
        }
        throw error
      }
      runDefs.delete(runId)
      resumeContextData.delete(runId)
      if (scope === useProjectStore.getState().currentProject?.path) {
        await ipc.invoke('fs:workflow-output-delete-run', runId)
      }
    } finally { resumingRuns.delete(runId) }
  },

  prepareForClose: async () => {
    if (!workflowCloseDrain) {
      closingWorkflows = true
      ++workflowCloseEpoch
      workflowCloseDrain = Promise.resolve().then(async () => {
        for (const run of [...get().activeRuns]) {
          if (run.type === 'directory') get().pauseWorkflow(run.id)
          else get().cancelWorkflow(run.id)
        }
        await Promise.allSettled([...executingRuns, ...startupReceipts.values()])
        await drainLLMRequests(id => ipc.invoke('llm:cancel', id).then(() => {}))
        flushAllPendingAppends()
        return await get().flushCheckpoint()
      }).catch(error => {
        try { renderLog('error', 'Workflow', `退出收尾失败：${String(error)}`) } catch { /* 保留失败结论 */ }
        return false
      }).finally(() => {
        closingWorkflows = false
        workflowCloseDrain = null
      })
    }
    return waitForCloseResult(workflowCloseDrain, CLOSE_DRAIN_TIMEOUT_MS)
  },

  addLog: (level, message) => {
    const now = Date.now()
    const entry = { ts: now, time: new Date(now).toLocaleTimeString(getCurrentLocale()), level, message }
    set((s) => ({
      globalLogs: [...s.globalLogs, entry].slice(-500), // 保留最近 500 条
    }))
    // 双写：内存（LogsView 展示）+ 主进程文件日志（持久化，用户反馈可查）
    renderLog(level, 'Workflow', message)
  },

  clearLogs: () => set({ globalLogs: [] }),

  // ===== Checkpoint 持久化 =====
  restoreCheckpoint: async () => {
    // L2 v2：从 DB 读 checkpoint（loadCheckpoint 自有 localStorage 兜底迁移）。
    // 恢复决断：可重建（rehydrateWorkflow 有 factory）→ 真续跑；
    //   不可重建 → 旧兜底（waiting→failed 提示重跑 / running→paused 可取消重跑）。
    if (closingWorkflows || isCloseCoordinating()) return null
    const restoreEpoch = workflowCloseEpoch
    const cp = await loadCheckpoint()
    if (closingWorkflows || restoreEpoch !== workflowCloseEpoch) return null
    if (!cp) return cp
    const existingIds = new Set([...get().activeRuns, ...get().history].map(r => r.id))
    set(s => ({ history: [...s.history, ...(cp.history ?? []).filter(r => !existingIds.has(r.id))].slice(0, 50) }))
    cp.activeRuns = cp.activeRuns.filter(r => !existingIds.has(r.id))
    if (cp.activeRuns.length === 0) return cp
    // IMP-1：清旧断点上下文（多次恢复防残留），随后按 run 快照 checkpoint 的 contextData
    resumeContextData.clear()
    const interruptedWaitingIds = new Set(Object.keys(cp.waitingRuns ?? {}))
    // 动态 import 规避 store←→registry 静态循环（registry type-only import store，store 运行时 import registry）
    const m = await import('../services/workflows/workflow-registry')
    if (closingWorkflows || restoreEpoch !== workflowCloseEpoch) return null
    const restored: WorkflowRun[] = []
    // 恢复为「等待确认」的 run（其 waitingAfterStepIndex 需保留给 confirmContinue 定位断点）
    const keptWaitingIds: string[] = []
    // running 中断需自动重放的 run：先统一入列（set activeRuns）再 fire executeRunFromIndex——
    // 保证完成判定 finalRun 能命中；否则 startIndex>=steps.length（末步已完成与 run 完成间
    // 崩溃/定义漂移）的同步零迭代路径会因 run 尚未入 activeRuns 而 finalRun undefined →
    // 不计 completed/不触发 onComplete → run 永久 stuck running（final review Finding 2）。
    const runningReplays: Array<{ rr: WorkflowRun; def: WorkflowDefinition; startIndex: number }> = []
    for (const r of cp.activeRuns) {
      resumeContextData.set(r.id, cp.contextData?.[r.id] ?? {})
      if (r.status === 'paused' || r.type === 'directory') {
        restored.push({ ...r, status: 'paused', pauseRequested: false,
          steps: r.steps.map(step => step.status === 'running' ? { ...step, status: 'pending' as const, progress: 0 } : step),
          rehydrateParams: cp.runDefs?.[r.id]?.params ?? r.rehydrateParams })
        if (interruptedWaitingIds.has(r.id)) keptWaitingIds.push(r.id)
        continue
      }
      if (r.operationId || r.startupState === 'intent' || r.startupState === 'failed' || r.startupState === 'cancelled') {
        restored.push({ ...r, status: 'paused' })
        continue
      }
      // IMP-1：等待确认 run 无 activeContexts 条目，confirmContinue 重放靠此重建 ctx.data
      resumeContextData.set(r.id, cp.contextData?.[r.id] ?? {})
      // L2 final（§4.8）：runDefs 缺失（legacy pre-L2 localStorage checkpoint）→ 视为不可重建，走
      // else 旧兜底，避免空 params 命中 r.type 的兜底工厂（如 chapter_creation 写稿）误路由重放，或
      // novel_import 的 String(params.chapters.length) 解引用 undefined → TypeError 让整批 restore 拒绝。
      const runDef = cp.runDefs?.[r.id]
      const def = runDef ? m.rehydrateWorkflow(r.type, runDef.params) : null
      const isWaiting = interruptedWaitingIds.has(r.id)
      if (def) {
        // 可重建 → 真续跑：status 置 running（running 中断立即自动重放）或 waiting（点「继续」重放）。
        // I-1：恢复态对齐 running——executeRunFromIndex 完成判定依赖 status==='running'。
        const rr = { ...r, status: isWaiting ? ('waiting' as const) : ('running' as const) }
        restored.push(rr)
        if (isWaiting) {
          keptWaitingIds.push(r.id)
        } else {
          // running 中断 → 从 currentStepIndex 立即自动重放（contextData 恢复断点上下文）
          runningReplays.push({ rr, def, startIndex: rr.currentStepIndex })
        }
      } else {
        // 不可重建 → 旧兜底：waiting→failed（提示重跑）、running→paused（可取消重跑）
        if (isWaiting) {
          // 工作流标题是用户数据，可能含 $ 等特殊字符 → 箭头函数 replacer 防 $& 语义
          get().addLog('warn', t('log.workflow.restoreInterrupted').replace('{title}', () => r.title))
        }
        restored.push(isWaiting ? { ...r, status: 'failed' as const } : { ...r, status: 'paused' as const })
      }
    }
    set((s) => ({
      activeRuns: [...s.activeRuns, ...restored],
      // 保留「保持等待确认」的 waiting 标记（confirmContinue 依 waitingAfterStepIndex 定位断点）；
      // 已失败/已自动重放（非等待）的 run 不保留标记，避免「继续」按钮无效假象。
      waitingRuns: Object.fromEntries(
        Object.entries(cp.waitingRuns ?? {}).filter(([id]) => keptWaitingIds.includes(id))
      ),
    }))
    // running 自动重放：先入列（上方 set 已把 restored run 放进 activeRuns）再 fire，保证
    // executeRunFromIndex 完成判定能命中 finalRun（I-1/finalRun 正常），run 不 stuck running。
    for (const { rr, def, startIndex } of runningReplays) {
      void executeRunFromIndex(rr, def, startIndex, cp.contextData?.[rr.id] ?? {})
    }
    return cp
  },

  clearCheckpoint: () => clearCheckpoint(),

  hydrateInterruptedOutputs: async () => {
    // 只处理崩溃恢复回来的暂停/失败 run（正常 run 不落此状态，文件在其结束时已被任务级清理）
    const runs = get().activeRuns.filter(r => r.status === 'paused' || r.status === 'failed')
    for (const run of runs) {
      // 候选 = result 为空/缺失的步骤（文件存在才补——pending/未流式步骤无文件，天然跳过）
      const candidates = run.steps
        .map((step, index) => ({ index, step }))
        .filter(({ step }) => typeof step.result !== 'string' || step.result === '')
      for (const { index } of candidates) {
        try {
          const tail = await readStepOutputTail(run.id, index, { full: true })
          if (!tail.success || !tail.exists || tail.content === '') continue
          // cleanupMessageText：与 restoreCheckpoint 同语义净化（半截 think/tool 残片）
          updateStepById(set, run.id, index, { result: cleanupMessageText(tail.content) })
        } catch {
          // 单步补填失败不影响其余步骤/run
        }
      }
    }
  },
}))

// Auto-save checkpoint on beforeunload
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    const state = useWorkflowStore.getState()
    if (state.activeRuns.length > 0 || state.history.length > 0) saveCheckpoint(state)
  })
}

// ===== 工具函数（按 runId 操作） =====

/** 更新指定工作流的运行状态 */
function updateRunById(
  set: (fn: (s: WorkflowState) => Partial<WorkflowState>) => void,
  runId: string,
  updates: Partial<WorkflowRun>
) {
  set((s) => {
    const newRuns = s.activeRuns.map(r =>
      r.id === runId ? { ...r, ...updates } : r
    )
    return { activeRuns: newRuns, history: s.history.map(r => r.id === runId ? { ...r, ...updates } : r), ...computeCompat(newRuns, s.waitingRuns) }
  })
}

/** 更新指定工作流的指定步骤 */
function updateStepById(
  set: (fn: (s: WorkflowState) => Partial<WorkflowState>) => void,
  runId: string,
  stepIndex: number,
  updates: Partial<WorkflowStep>
) {
  set((s) => {
    const newRuns = s.activeRuns.map(r => {
      if (r.id !== runId) return r
      const steps = [...r.steps]
      steps[stepIndex] = { ...steps[stepIndex], ...updates }
      return { ...r, steps }
    })
    const history = s.history.map(r => {
      if (r.id !== runId) return r
      const steps = [...r.steps]
      steps[stepIndex] = { ...steps[stepIndex], ...updates }
      return { ...r, steps }
    })
    return { activeRuns: newRuns, history, ...computeCompat(newRuns, s.waitingRuns) }
  })
}

/** 追加指定工作流的指定步骤日志 */
function appendStepLogById(
  set: (fn: (s: WorkflowState) => Partial<WorkflowState>) => void,
  runId: string,
  stepIndex: number,
  message: string
) {
  set((s) => {
    const newRuns = s.activeRuns.map(r => {
      if (r.id !== runId) return r
      const steps = [...r.steps]
      steps[stepIndex] = {
        ...steps[stepIndex],
        logs: [...steps[stepIndex].logs, `[${new Date().toLocaleTimeString(getCurrentLocale())}] ${message}`],
      }
      return { ...r, steps }
    })
    return { activeRuns: newRuns, ...computeCompat(newRuns, s.waitingRuns) }
  })
}

/**
 * L2：把原 startWorkflow 内联执行循环抽为按任意断点 index 推进的可重入函数。
 *
 * - `startIndex` 之前的步骤视为已完成（断点重放：跳过，不重跑）；
 * - `contextData` 作为重放起点的工作流上下文字段（executor 经 `ctx.data` 读到）；
 * - 完成后处理（完成判定/onComplete/入历史/清理/PERSIST）与本函数一体
 *   （Task 5 save/load/restore 复用；index 0 调用 = 原 startWorkflow 内联循环等价）。
 * `activeContexts`/`continueResolveRefs` 保持模块级进程内语义（此函数重建 context）。
 * `stepByStep`（可选，仅 startWorkflow 传入）：重放/续跑路径默认 false（不再暂停）。
 */
const executingRuns = new Set<Promise<void>>()
let closingWorkflows = false
let workflowCloseDrain: Promise<boolean> | null = null
let workflowCloseEpoch = 0

export async function executeRunFromIndex(
  run: WorkflowRun,
  definition: WorkflowDefinition,
  startIndex: number,
  contextData: Record<string, unknown>,
  stepByStep = false,
): Promise<void> {
  const state = useWorkflowStore.getState()
  if (closingWorkflows || isCloseCoordinating() || run.cancellationRequestedAt || state.history.some(r => r.id === run.id)
    || !state.activeRuns.some(r => r.id === run.id)) return
  if (state.activeRuns.find(r => r.id === run.id)?.pauseRequested) {
    updateRunById(useWorkflowStore.setState, run.id, { status: 'paused', pauseRequested: false })
    await saveCheckpoint(useWorkflowStore.getState())
    return
  }
  if (runExecutions.has(run.id)) return
  const execution = executeRunBody(run, definition, startIndex, contextData, stepByStep)
  runExecutions.set(run.id, execution)
  executingRuns.add(execution)
  try { await execution } finally {
    executingRuns.delete(execution)
    runExecutions.delete(run.id)
    runControllers.delete(run.id)
  }
}

async function executeRunBody(
  run: WorkflowRun,
  definition: WorkflowDefinition,
  startIndex: number,
  contextData: Record<string, unknown>,
  stepByStep = false,
): Promise<void> {
  const set = useWorkflowStore.setState
  const get = () => useWorkflowStore.getState()

  // 重建执行上下文（模块级进程内 Map 语义）
  const controller = new AbortController()
  runControllers.set(run.id, controller)
  const context: WorkflowContext = {
    data: contextData,
    cancelled: !!get().history.find(r => r.id === run.id)?.cancellationRequestedAt,
    signal: controller.signal,
    checkpoint: () => saveCheckpoint(get(), true),
  }
  activeContexts.set(run.id, context)

  // I-1（跨任务硬约束）：进入执行循环前把 run 状态对齐为 running——保证完成判定
  // finalRun.status==='running' 成立。对 startWorkflow 正常路径无害（其开始已 set running）；
  // 对跨重启 waiting 点「继续」重放必要（restore 后 run 为 waiting，若不对齐则重放完成后
  // 不会被标记 completed，断点重放永远打不到 completed）；对 restoreCheckpoint 自动重放的
  // run（尚未入 activeRuns）此写入为 no-op，其 running 态由 restoreCheckpoint 自身置位。
  updateRunById(set, run.id, { status: 'running' })

  // 逐步执行（从断点 startIndex 起）
  for (let i = startIndex; i < definition.steps.length; i++) {
    // 检查取消
    if (context.cancelled) {
      updateRunById(set, run.id, { status: 'failed' })
      get().addLog('warn', `[Cancel] ${definition.title}`)
      break
    }

    const stepDef = definition.steps[i]

    // 标记当前步骤为运行中
    updateStepById(set, run.id, i, { status: 'running', progress: 0, error: undefined, completedAt: undefined, startedAt: new Date().toISOString() })
    updateRunById(set, run.id, { currentStepIndex: i })
    get().addLog('info', `[${definition.title}] ${stepDef.name}`)

    // 创建步骤回调
    const callbacks: StepCallbacks = {
      log: (message) => {
        appendStepLogById(set, run.id, i, message)
        get().addLog('info', `  ${message}`)
      },
      setProgress: (progress) => {
        updateStepById(set, run.id, i, { progress })
      },
      appendText: (text) => {
        // 共享限频调度：只累积 + 安排统一 flush（timer 保证最小间隔），
        // 不在此同步 setState——避免 LLM 流式高频 chunk 阻塞主线程
        const key = `${run.id}:${i}`
        pendingAppendFlushes.set(key, (pendingAppendFlushes.get(key) ?? '') + text)
        scheduleAppendFlush()
      },
    }

    try {
      const result = await stepDef.executor(run.steps[i], context, callbacks)
      // 刷新该步骤流式缓冲残留（立即写入，避免 timer 晚于步骤完成）
      flushAppendTextNow(`${run.id}:${i}`)
      if (context.cancelled) break
      updateStepById(set, run.id, i, {
        status: 'completed',
        completedAt: new Date().toISOString(),
        progress: 100,
        result: result || [...get().activeRuns, ...get().history].find(r => r.id === run.id)?.steps[i].result,
      })
      get().addLog('info', `[${definition.title}] ${stepDef.name} — OK`)
      saveCheckpoint(get())

      // 步进模式：非最后一步，且未取消 → 暂停等待用户确认
      if (stepByStep && i < definition.steps.length - 1 && !context.cancelled) {
        updateRunById(set, run.id, { status: 'waiting' })
        set(s => {
          const newWaiting = { ...s.waitingRuns, [run.id]: { waitingForConfirm: true, waitingAfterStepIndex: i } }
          return { waitingRuns: newWaiting, ...computeCompat(s.activeRuns, newWaiting) }
        })
        get().addLog('info', `[${definition.title}] Waiting: step ${i + 2} — ${definition.steps[i + 1].name}`)
        void saveCheckpoint(get())
        await new Promise<void>((resolve) => { continueResolveRefs.set(run.id, resolve) })
        if (context.cancelled) break
        updateRunById(set, run.id, { status: 'running' })
      }
    } catch (error) {
      flushAppendTextNow(`${run.id}:${i}`)
      if (context.cancelled) break
      const errorMsg = error instanceof Error ? error.message : String(error)
      updateStepById(set, run.id, i, {
        status: 'failed',
        error: errorMsg,
        completedAt: new Date().toISOString(),
      })
      updateRunById(set, run.id, { status: 'failed', completedAt: new Date().toISOString() })
      // D 档：失败也要广播（带 runId）——自动化侧据此把 automation_runs 标 failed，
      // 否则 run 表会留下永久 running 的幽灵记录（评审 Important 3）
      import('../shared/event-bus').then(m => {
        m.globalEventBus.emit('WORKFLOW_COMPLETE', { type: definition.type, runId: run.id, status: 'failed' })
      }).catch(() => {})
      get().addLog('error', `[${definition.title}] ${stepDef.name} — FAIL: ${errorMsg}`)
      break
    }
  }

  if (get().activeRuns.find(r => r.id === run.id)?.pauseRequested) {
    resumeContextData.set(run.id, context.data)
    activeContexts.delete(run.id)
    clearAppendBuffers(run.id)
    const pausedRun = get().activeRuns.find(r => r.id === run.id)
    if (pausedRun?.steps[pausedRun.currentStepIndex]?.status === 'running') {
      updateStepById(set, run.id, pausedRun.currentStepIndex, { status: 'pending' })
    }
    updateRunById(set, run.id, { status: 'paused', pauseRequested: false })
    try { await saveCheckpoint(get(), true) } catch {
      get().addLog('error', '暂停进度保存失败，请重试保存后再退出。')
    }
    return
  }

  // 检查是否全部完成
  const finalRun = get().activeRuns.find(r => r.id === run.id)
  if (finalRun && finalRun.status === 'running') {
    updateRunById(set, run.id, { status: 'completed', completedAt: new Date().toISOString() })
    saveCheckpoint(get())
    get().addLog('info', `[Done] ${definition.title}`)

    // 通过 EventBus 广播工作流完成事件（替代 window.dispatchEvent）
    import('../shared/event-bus').then(m => {
      m.globalEventBus.emit('WORKFLOW_COMPLETE', { type: definition.type, runId: run.id, status: 'success' })
    }).catch(() => {})

    // ===== 执行 onComplete 通知/跳转 =====
    if (definition.onComplete) {
      const { mode, openResult } = definition.onComplete
      try {
        if (mode === 'open' && openResult) {
          // 直接打开结果
          await openResult()
        }
        // silent 模式不做额外操作
      } catch (e) {
        get().addLog('warn', `onComplete failed: ${e}`)
      }
    }
  }

  // 从活跃列表移除，存入历史
  set(s => {
    const completedRun = s.activeRuns.find(r => r.id === run.id)
    const newRuns = s.activeRuns.filter(r => r.id !== run.id)
    const newWaiting = { ...s.waitingRuns }
    delete newWaiting[run.id]
    const newHistory = completedRun
      ? [{ ...completedRun, resumeData: completedRun.type === 'directory' && completedRun.status !== 'completed' ? context.data : undefined }, ...s.history].slice(0, 50)
      : s.history
    return {
      activeRuns: newRuns,
      history: newHistory,
      waitingRuns: newWaiting,
      ...computeCompat(newRuns, newWaiting),
    }
  })

  // 清理上下文与流式缓冲
  activeContexts.delete(run.id)
  continueResolveRefs.delete(run.id)
  resumeContextData.delete(run.id)
  clearAppendBuffers(run.id)
  try {
    await saveCheckpoint(get(), true)
    if (!get().history.find(r => r.id === run.id)?.cancellationRequestedAt) deleteRunOutput(run.id)
  } catch {
    get().addLog('error', '工作流执行记录保存失败，恢复输出已保留，请重试保存后再退出。')
  }
}
