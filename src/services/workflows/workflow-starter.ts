/**
 * 工作流启动器（workflow-starter）
 *
 * 原 start_workflow 工具内部的构建逻辑（buildDraftWorkflow 等）提取为独立服务层模块，
 * 供工具层（start-workflow.tool.ts）与意图预路由（A3）共用：
 * - 成功路径不变：startChapterWorkflow 返回 { runId, displayName, chapterTag }，
 *   蓝图/架构返回 { runId, displayName }
 * - 失败语义统一：所有异常路径 throw WorkflowStartError
 *   （ERR_GUARD / ERR_NO_DRAFT / ERR_NO_BLUEPRINT），调用方按 code 映射用户可见文案
 *
 * 语义约定（P0-3）：
 * - buildDraftWorkflow 从不返回 null——guard 失败 throw（catch 转 ERR_GUARD）、
 *   蓝图缺失 throw WorkflowStartError('ERR_NO_BLUEPRINT')（防止被 catch 误归 ERR_GUARD）
 * - review/refine/finalize 无草稿 return null → startChapterWorkflow 统一转 ERR_NO_DRAFT
 *
 * 启动即回执（2026-10-02 评审 C1 修复）：三个 start* 均在 run 开始即返回 runId，**不等 run 结束**——
 * agent-engine 对工具调用有 30s 超时且超时不中止执行，等待型调用必被腰斩（模型看到假超时、返回值与
 * artifacts 被丢弃）；进度交给任务面板 / AI 输出面板（与现有交互一致）。
 */
import { t } from '../../shared/locale'
import { ipc } from '../ipc-client'
import { useWorkflowStore } from '../../stores/workflow-store'
import type { WorkflowDefinition } from '../../stores/workflow-store'
import { toast } from '../../components/ui/Toast'
import { DEFAULT_WORDS_PER_CHAPTER } from '../../shared/constants'
import { useProjectStore } from '../../stores/project-store'
import type { ToolExecutionContext } from '../agent/tool-registry'

function captureContext(context?: ToolExecutionContext): ToolExecutionContext | undefined {
  if (!context) return undefined
  const captured = { ...context, scope: context.scope ?? useProjectStore.getState().currentProject?.path }
  checkStartup(captured)
  return captured
}

function checkStartup(context?: ToolExecutionContext): void {
  if (!context) return
  if (context.signal.aborted || context.scope !== useProjectStore.getState().currentProject?.path) {
    throw new DOMException('工作流启动已取消或项目已切换', 'AbortError')
  }
}

/** 工作流启动失败：带错误 code，供调用方语义化映射文案 */
export class WorkflowStartError extends Error {
  readonly code: 'ERR_GUARD' | 'ERR_NO_DRAFT' | 'ERR_NO_BLUEPRINT'

  constructor(code: 'ERR_GUARD' | 'ERR_NO_DRAFT' | 'ERR_NO_BLUEPRINT', message: string) {
    super(message)
    this.name = 'WorkflowStartError'
    this.code = code
  }
}

// ---- 工作流类型到显示名的映射 ----

function getWorkflowDisplayName(workflow: string): string {
  switch (workflow) {
    case 'generate_draft': return t('tool.wfDraft')
    case 'review': return t('tool.wfReview')
    case 'refine': return t('tool.wfRefine')
    case 'finalize': return t('tool.wfFinalize')
    case 'generate_blueprint': return t('tool.wfBlueprint')
    case 'generate_architecture': return t('tool.wfArchitecture')
    case 'config_generation': return t('tool.wfConfig')
    case 'generate_book': return t('tool.wfBook')
    default: return workflow
  }
}

/**
 * 启动即回执（2026-10-02 评审 C1 修复）：用 store 既有 `onStarted` 回执（D 档同款语义）——
 * run 一开始就 resolve runId，不等整个 run 跑完。run 体晚到的 rejection 在此吞掉
 * （run 失败已由 workflow-store 的状态呈现），避免 unhandledrejection。
 */
function startWithReceipt(definition: WorkflowDefinition, context?: ToolExecutionContext): Promise<string> {
  checkStartup(context)
  return new Promise<string>((resolve, reject) => {
    useWorkflowStore.getState().startWorkflow(definition, false, {
      onStarted: resolve,
      signal: context?.signal,
      operationId: context?.operationId,
      scope: context?.scope,
      beforeStart: () => checkStartup(context),
    }).catch(reject)
  })
}

// ===== 章节工作流入口 =====

/**
 * 启动章节类工作流（写稿/审稿/修稿/定稿）
 *
 * @returns 工作流实例信息（runId + 展示名 + 章节标签），成功语义与工具层原行为一致
 * @throws WorkflowStartError
 *   - ERR_GUARD：guard 失败（如无蓝图/无角色卡/前一章未定稿）或其他未预期异常
 *   - ERR_NO_DRAFT：review/refine/finalize 无草稿（原 return null 的语义化统一）
 *   - ERR_NO_BLUEPRINT：generate_draft 蓝图数据缺失（与 guard 失败区分——提示先生成蓝图）
 */
export async function startChapterWorkflow(
  workflow: 'generate_draft' | 'review' | 'refine' | 'finalize',
  chapterNumber: number,
  context?: ToolExecutionContext,
): Promise<{ runId: string; displayName: string; chapterTag: string }> {
  context = captureContext(context)
  const displayName = getWorkflowDisplayName(workflow)
  const chapterTag = t('tool.chapterTag').replace('{n}', String(chapterNumber))
  let definition: WorkflowDefinition | null | undefined
  try {
    switch (workflow) {
      case 'generate_draft': definition = await buildDraftWorkflow(chapterNumber, context); break
      case 'review': definition = await buildReviewWorkflow(chapterNumber, context); break
      case 'refine': definition = await buildRefineWorkflow(chapterNumber, context); break
      case 'finalize': definition = await buildFinalizeWorkflow(chapterNumber, context); break
    }
  } catch (e) {
    // P0-3 语义归类：WorkflowStartError 透传（ERR_NO_BLUEPRINT 由 buildDraftWorkflow 内 throw）；
    // guard 失败与其他异常 → ERR_GUARD
    checkStartup(context)
    throw e instanceof WorkflowStartError
      ? e
      : new WorkflowStartError('ERR_GUARD', e instanceof Error ? e.message : String(e))
  }
  checkStartup(context)
  // 仅 review/refine/finalize 可达（generate_draft 从不返回 null——蓝图缺失已在 buildDraftWorkflow 内 throw ERR_NO_BLUEPRINT）
  if (!definition) {
    // 评审修复（I1）：按 workflow 参数化 ERR_NO_DRAFT 文案——意图层（agent-store handleWritingIntent）
    // 对 ERR_NO_DRAFT 透传 e.message（「润色第3章」无草稿曾收到「第{n}章没有可审稿的草稿」）；
    // 工具层按 workflow 重映射仍保留（无害，文案一致）
    const noDraftMsg = workflow === 'refine'
      ? t('tool.wfNoRefineDraft')
      : workflow === 'finalize'
        ? t('tool.wfNoFinalizeDraft')
        : t('tool.wfNoReviewDraft')
    throw new WorkflowStartError('ERR_NO_DRAFT', noDraftMsg.replace('{chapter}', String(chapterNumber)))
  }
  const runId = await startWithReceipt(definition, context)
  return { runId, displayName, chapterTag }
}

// ===== 蓝图/架构工作流入口 =====

/** 启动蓝图（目录）工作流——guard 失败 throw ERR_GUARD */
export async function startBlueprintWorkflow(context?: ToolExecutionContext): Promise<{ runId: string; displayName: string }> {
  context = captureContext(context)
  const displayName = getWorkflowDisplayName('generate_blueprint')
  const { guardDirectoryGeneration } = await import('./workflow-guards')
  checkStartup(context)
  const guard = await guardDirectoryGeneration()
  checkStartup(context)
  if (!guard.ok) {
    throw new WorkflowStartError('ERR_GUARD', guard.message || t('error.prereqNotMet'))
  }
  const { createDirectoryWorkflow } = await import('./directory-workflow')
  checkStartup(context)
  const runId = await startWithReceipt(createDirectoryWorkflow({ mode: 'full' }), context)
  return { runId, displayName }
}

/** 启动架构生成工作流——guard 失败 throw ERR_GUARD */
export async function startArchitectureWorkflow(context?: ToolExecutionContext): Promise<{ runId: string; displayName: string }> {
  context = captureContext(context)
  const displayName = getWorkflowDisplayName('generate_architecture')
  const { guardArchitectureGeneration } = await import('./workflow-guards')
  checkStartup(context)
  const guard = guardArchitectureGeneration()
  if (!guard.ok) {
    throw new WorkflowStartError('ERR_GUARD', guard.message || t('error.prereqNotMet'))
  }
  const { createArchitectureWorkflow } = await import('./architecture-workflow')
  checkStartup(context)
  const runId = await startWithReceipt(createArchitectureWorkflow(), context)
  return { runId, displayName }
}

/**
 * 启动整本流水线：逐章串行「写稿 → 自审/重写 → 定稿 → KB/记忆」。
 *
 * 与 generate_draft 区间模式的本质区别：
 *   - 区间模式把每章独立启动，第 2 章会因前一章未定稿而中止；
 *   - 本入口把前一章的 finalize 后处理作为下一章写稿的硬前置，失败即停。
 */
export async function startBookPipelineWorkflow(params: {
  chapterStart: number
  chapterEnd: number
  autoReview?: boolean
  reuseExistingDrafts?: boolean
}, context?: ToolExecutionContext): Promise<{ runId: string; displayName: string; chapterTag: string }> {
  context = captureContext(context)
  const displayName = getWorkflowDisplayName('generate_book')
  const { chapterStart, chapterEnd } = params

  if (!Number.isInteger(chapterStart) || !Number.isInteger(chapterEnd) || chapterStart < 1 || chapterEnd < chapterStart) {
    throw new WorkflowStartError('ERR_GUARD', t('tool.wfRangeInvalid'))
  }
  if (chapterEnd - chapterStart + 1 > 100) {
    throw new WorkflowStartError('ERR_GUARD', t('tool.wfRangeTooLarge').replace('{max}', '100'))
  }

  checkStartup(context)
  const project = useProjectStore.getState().currentProject
  if (!project) throw new WorkflowStartError('ERR_GUARD', t('error.noProject'))

  const totalChapters = project.novelConfig.totalChapters || 0
  if (totalChapters > 0 && chapterEnd > totalChapters) {
    throw new WorkflowStartError('ERR_GUARD', t('workflow.bookPipelineOutOfRange')
      .replace('{end}', String(chapterEnd))
      .replace('{total}', String(totalChapters)))
  }

  // 复用单章 guard：蓝图存在、角色卡存在、若 start>1 则前一章已定稿且后处理通过
  const { guardChapterWriting } = await import('./workflow-guards')
  checkStartup(context)
  const guard = await guardChapterWriting(chapterStart)
  checkStartup(context)
  if (!guard.ok) {
    throw new WorkflowStartError('ERR_GUARD', guard.message || t('error.prereqNotMet'))
  }

  // 范围内每一章都必须有蓝图，否则流水线跑到中间才失败，浪费前面章节的 token
  const blueprints = await ipc.invoke('db:blueprint-get-all') as Array<{ chapterNumber: number }> | null
  checkStartup(context)
  const existing = new Set((blueprints ?? []).map(b => Number(b.chapterNumber)))
  for (let n = chapterStart; n <= chapterEnd; n++) {
    if (!existing.has(n)) {
      throw new WorkflowStartError('ERR_GUARD', t('workflow.bookPipelineMissingBlueprint').replace('{n}', String(n)))
    }
  }

  const { createBookPipelineWorkflow } = await import('./book-pipeline-workflow')
  checkStartup(context)
  const runId = await startWithReceipt(createBookPipelineWorkflow({
    chapterStart,
    chapterEnd,
    autoReview: params.autoReview,
    reuseExistingDrafts: params.reuseExistingDrafts,
  }), context)
  return {
    runId,
    displayName,
    chapterTag: t('tool.chapterRangeTag')
      .replace('{start}', String(chapterStart))
      .replace('{end}', String(chapterEnd)),
  }
}

/**
 * 启动配置生成工作流（线③ 第 4 条：Agent 起 config_generation）。
 * idea = Agent 从用户意图提取的「创作脑洞」；规模参数读当前项目配置。
 * onGenerated 复用线③ 第 1 条的快照 + 应用 + 撤销出口（与 NovelConfigEditor 同款）。
 */
export async function startConfigGenerationWorkflow(idea: string, context?: ToolExecutionContext): Promise<{ runId: string; displayName: string }> {
  context = captureContext(context)
  const displayName = getWorkflowDisplayName('config_generation')
  checkStartup(context)
  const project = useProjectStore.getState().currentProject
  if (!project) {
    throw new WorkflowStartError('ERR_GUARD', t('error.noProject'))
  }
  const totalChapters = project.novelConfig.totalChapters || 100
  const wordsPerChapter = project.novelConfig.wordsPerChapter || DEFAULT_WORDS_PER_CHAPTER
  const { createConfigGenerationWorkflow } = await import('./architecture-workflow')
  checkStartup(context)
  const runId = await startWithReceipt(createConfigGenerationWorkflow({
    idea,
    totalChapters,
    wordsPerChapter,
    onGenerated: (parsed) => {
      if (useProjectStore.getState().currentProject?.path !== project.path) return
      const store = useProjectStore.getState()
      store.snapshotNovelConfig()
      store.updateNovelConfig(parsed)
      toast.show({
        type: 'ai',
        message: t('novelConfig.aiApplied'),
        actions: [{
          label: t('action.undoShort'),
          onClick: () => {
            if (store.restoreNovelConfigSnapshot()) toast.success(t('novelConfig.aiReverted'))
          },
        }],
      })
    },
  }), context)
  return { runId, displayName }
}

// ===== 工作流构建辅助函数 =====

/** 从数据库蓝图构建 ChapterInfo */
async function getChapterInfoFromBlueprint(chapterNumber: number) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bp = await ipc.invoke('db:blueprint-get', chapterNumber) as any
    if (!bp) return null
    return {
      chapterNumber,
      title: (bp.title as string) || t('tool.chapterTag').replace('{n}', String(chapterNumber)),
      role: (bp.role as string) || '',
      purpose: (bp.purpose as string) || '',
      characters: Array.isArray(bp.characters)
        ? (bp.characters as string[])
        : [],
      keyEvents: (bp.keyEvents as string) || '',
      suspenseHook: bp.suspenseHook as string | undefined,
      userGuidance: bp.userGuidance as string | undefined,
    }
  } catch {
    return null
  }
}

/** 获取章节的最新草稿内容 */
async function getLatestDraft(chapterNumber: number): Promise<{
  filePath: string
  content: string
  title: string
  meta: Record<string, unknown>
} | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const drafts = await ipc.invoke('db:draft-list', chapterNumber) as any[]
    if (!drafts || drafts.length === 0) return null
    // 取最新版本
    const latest = drafts.sort((a, b) => b.version - a.version)[0]
    const full = await ipc.invoke('db:draft-get-full', latest.id) as { content: string } | null
    if (!full) return null
    return {
      filePath: `vela://draft/${latest.id}`,
      content: full.content,
      title: (latest.title as string) || t('tool.chapterTag').replace('{n}', String(chapterNumber)),
      meta: latest,
    }
  } catch {
    return null
  }
}

/** 构建写稿工作流 */
async function buildDraftWorkflow(chapterNumber: number, context?: ToolExecutionContext) {
  const { guardChapterWriting } = await import('./workflow-guards')
  checkStartup(context)
  const guard = await guardChapterWriting(chapterNumber)
  checkStartup(context)
  if (!guard.ok) {
    // guard 失败直接抛出，由 startChapterWorkflow 的 catch 统一转 ERR_GUARD
    throw new Error(guard.message || t('error.prereqNotMet'))
  }

  const chapterInfo = await getChapterInfoFromBlueprint(chapterNumber)
  checkStartup(context)
  if (!chapterInfo) {
    // P0-3：蓝图缺失单独归类（ERR_NO_BLUEPRINT），避免被 catch 误归为 ERR_GUARD
    throw new WorkflowStartError(
      'ERR_NO_BLUEPRINT',
      t('tool.wfBlueprintDataMissing').replace('{chapter}', String(chapterNumber)),
    )
  }

  const { createChapterWorkflow } = await import('./chapter-workflow')
  return createChapterWorkflow(chapterInfo)
}

/** 构建审稿工作流 */
async function buildReviewWorkflow(chapterNumber: number, context?: ToolExecutionContext) {
  const draft = await getLatestDraft(chapterNumber)
  checkStartup(context)
  if (!draft) return null

  const { createReviewOnlyWorkflow } = await import('./chapter-workflow')
  return createReviewOnlyWorkflow({
    chapterNumber,
    chapterTitle: draft.title,
    draftPath: draft.filePath,
    draftContent: draft.content,
  })
}

/** 构建修稿工作流 */
async function buildRefineWorkflow(chapterNumber: number, context?: ToolExecutionContext) {
  const draft = await getLatestDraft(chapterNumber)
  checkStartup(context)
  if (!draft) return null

  const { getCurrentDraftReview } = await import('../review-actions')
  const reviewReport = await getCurrentDraftReview(Number(draft.meta.id), draft.content, useProjectStore.getState().currentProject?.id ?? '')
  checkStartup(context)

  if (reviewReport) {
    const { createRefineFromReviewWorkflow } = await import('./chapter-workflow')
    return createRefineFromReviewWorkflow({
      chapterNumber,
      chapterTitle: draft.title,
      draftPath: draft.filePath,
      draftContent: draft.content,
      reviewReport,
      reviewFileName: `review_ch${chapterNumber}`,
    })
  }

  const { createRefineOnlyWorkflow } = await import('./chapter-workflow')
  return createRefineOnlyWorkflow({
    chapterNumber,
    chapterTitle: draft.title,
    draftPath: draft.filePath,
    draftContent: draft.content,
  })
}

/** 构建定稿工作流 */
async function buildFinalizeWorkflow(chapterNumber: number, context?: ToolExecutionContext) {
  const draft = await getLatestDraft(chapterNumber)
  checkStartup(context)
  if (!draft) return null

  const { createFinalizeWorkflow } = await import('./chapter-workflow')
  return createFinalizeWorkflow({
    chapterNumber,
    chapterTitle: draft.title,
    draftPath: draft.filePath,
    draftContent: draft.content,
  })
}
