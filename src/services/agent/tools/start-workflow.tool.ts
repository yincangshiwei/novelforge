/**
 * start_workflow — 触发创作工作流
 *
 * 当 Agent 判断用户意图是执行某个创作任务（写稿、审稿、修稿、定稿、
 * 生成蓝图、生成架构）时，调用此 Tool 真正启动对应的多步骤工作流。
 * 工作流启动后会自动在底部任务面板和右侧 AI 输出面板中展示进度。
 *
 * 工作流构建逻辑已提取至 services/workflows/workflow-starter（与意图预路由 A3 共用）；
 * 本工具层只负责参数校验与错误语义映射（WorkflowStartError.code → 用户可见文案）。
 */
import { buildAgentTool } from '../tool-registry'
import { t } from '../../../shared/locale'
import { useLayoutStore } from '../../../stores/layout-store'
import { useProjectStore } from '../../../stores/project-store'
import { findWorkflowOperation } from '../../../stores/workflow-store'
import { ToolExecutionInterrupted } from '../tool-execution'
import {
  startChapterWorkflow,
  startBlueprintWorkflow,
  startArchitectureWorkflow,
  startConfigGenerationWorkflow,
  startBookPipelineWorkflow,
  WorkflowStartError,
} from '../../workflows/workflow-starter'

/** 区间单次最多章数（2026-10-02 评审 I1：模型幻觉大区间 → 无界静默启动的护栏） */
const MAX_RANGE_CHAPTERS = 20

export const startWorkflowTool = buildAgentTool({
  name: 'start_workflow',
  description: t('tool.startWorkflowDesc'),
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {
      workflow: {
        type: 'string',
        description: t('tool.startWorkflowType'),
        enum: ['generate_book', 'generate_draft', 'review', 'refine', 'finalize', 'generate_blueprint', 'generate_architecture', 'config_generation'],
      },
      chapter_number: {
        type: 'number',
        description: t('tool.startWorkflowChapter'),
      },
      chapter_end: {
        type: 'number',
        description: t('tool.startWorkflowChapterEnd'),
      },
      idea: {
        type: 'string',
        description: t('tool.startWorkflowIdea'),
      },
      auto_review: {
        type: 'boolean',
        description: t('tool.startWorkflowAutoReview'),
      },
    },
    required: ['workflow'],
  },
  requiresConfirmation: true,
  isReadOnly: false,
  reconcile: async (args, context) => {
    const project = useProjectStore.getState().currentProject
    if (!project || context.signal.aborted || (context.scope && context.scope !== project.path)) return undefined
    const workflow = String(args.workflow ?? '')
    const ranged = ['generate_draft', 'review', 'refine', 'finalize'].includes(workflow) && args.chapter_end != null
    const start = Number(args.chapter_number)
    const end = Number(args.chapter_end)
    if (ranged && (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end - start + 1 > MAX_RANGE_CHAPTERS)) return undefined
    const originalOperationId = context.originalOperationId ?? context.operationId
    const operations = ranged ? Array.from({ length: end - start + 1 }, (_, i) => `${originalOperationId}:chapter:${start + i}`) : [originalOperationId]
    const runs = operations.map(id => findWorkflowOperation(id, context.scope))
    if (runs.every(run => run && ['cancelled', 'failed'].includes(run.startupState ?? '')
      && run.steps.every(step => step.status === 'pending' && step.logs.length === 0))) {
      return { success: false, executionState: 'not_committed', content: '已核验原工作流启动失败，未执行任何步骤，可重新发起。' }
    }
    if (runs.some(run => !run || run.startupState !== 'started')) return undefined
    return {
      success: true,
      executionState: 'committed',
      content: '已核验原操作对应工作流启动记录；不重复启动。\n' + runs.map((run, index) => `${ranged ? `第${start + index}章：` : ''}${run!.title}，${run!.id}，状态=${run!.status}`).join('\n'),
      artifacts: runs.map((run, index) => ({ type: 'workflow_started' as const, name: run!.title, metadata: { runId: run!.id, workflow, operationId: run!.operationId, status: run!.status, ...(workflow === 'generate_blueprint' ? {
        chapterNumber: run!.rehydrateParams?.startChapter ?? 1,
        chapterEnd: Number(run!.rehydrateParams?.startChapter ?? 1) + Number(run!.rehydrateParams?.count ?? project.novelConfig.totalChapters) - 1,
      } : ranged ? { chapterNumber: start + index } : {}) } })),
      persistence: { target: `workflow:${workflow}`, verified: true, projectPath: project.path },
    }
  },
  execute: async (args, context) => {
    const projectPath = useProjectStore.getState().currentProject?.path
    const assertActive = () => {
      if (context?.signal.aborted || (context && useProjectStore.getState().currentProject?.path !== projectPath) || (context?.scope && context.scope !== projectPath)) throw new ToolExecutionInterrupted('操作已取消或项目已切换，工作流未启动', false)
    }
    assertActive()
    const workflow = args.workflow as string
    // null 归一（2026-10-02 复审 M1）：模型对未用的可选参数常发 null——一律视为未传（否则误报「区间无效」）
    const chapterNumber = args.chapter_number == null ? undefined : (args.chapter_number as number)
    const chapterEnd = args.chapter_end == null ? undefined : (args.chapter_end as number)
    const idea = args.idea == null ? undefined : String(args.idea).trim()

    if (!workflow) {
      return { success: false, content: '', error: t('error.missingWorkflow') }
    }

    // 整本流水线：逐章串行「写稿 → 自审/重写 → 定稿 → KB/记忆」。
    // 与 generate_draft 区间模式不同，前一章 finalize 后处理通过后才会进入下一章。
    if (workflow === 'generate_book') {
      const start = chapterNumber ?? 1
      const end = chapterEnd ?? start
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
        return { success: false, content: '', error: t('tool.wfRangeInvalid') }
      }
      if (end - start + 1 > 100) {
        return { success: false, content: '', error: t('tool.wfRangeTooLarge').replace('{max}', '100') }
      }
      try {
        const result = await startBookPipelineWorkflow({
          chapterStart: start,
          chapterEnd: end,
          autoReview: args.auto_review !== false,
        }, context)
        return {
          success: true,
          executionState: 'committed',
          content: t('tool.bookPipelineStarted')
            .replace('{name}', result.displayName)
            .replace('{range}', result.chapterTag),
          artifacts: [{ type: 'workflow_started' as const, name: `${result.displayName} ${result.chapterTag}`, metadata: { runId: result.runId, workflow, chapterNumber: start, chapterEnd: end } }],
        }
      } catch (e) {
        if (e instanceof WorkflowStartError) {
          return { success: false, content: '', error: e.message || t('error.prereqNotMet') }
        }
        throw e
      }
    }

    const chapterWorkflows = ['generate_draft', 'review', 'refine', 'finalize']
    if (chapterWorkflows.includes(workflow) && chapterNumber === undefined) {
      return { success: false, content: '', error: t('tool.wfNeedChapter').replace('{workflow}', workflow) }
    }

    // 章号合法性（2026-10-02 评审 I1）：整数且 ≥1——模型可能给小数/0（此前直接透传给 starter）
    if (chapterWorkflows.includes(workflow) && chapterNumber !== undefined
      && (!Number.isInteger(chapterNumber) || chapterNumber < 1)) {
      return { success: false, content: '', error: t('tool.wfRangeInvalid') }
    }

    // 区间合法性（2026-10-02）：chapter_end 整数且 ≥ chapter_number；上限护栏防幻觉大区间无界启动
    if (chapterWorkflows.includes(workflow) && chapterEnd !== undefined
      && (!Number.isInteger(chapterEnd) || chapterEnd < chapterNumber!)) {
      return { success: false, content: '', error: t('tool.wfRangeInvalid') }
    }
    if (chapterWorkflows.includes(workflow) && chapterEnd !== undefined
      && chapterEnd - chapterNumber! + 1 > MAX_RANGE_CHAPTERS) {
      return { success: false, content: '', error: t('tool.wfRangeTooLarge').replace('{max}', String(MAX_RANGE_CHAPTERS)) }
    }

    // 打开右侧面板到 AI 输出视图
    assertActive()
    useLayoutStore.getState().openRightPanel('ai-output')

    try {
      switch (workflow) {
        case 'generate_draft':
        case 'review':
        case 'refine':
        case 'finalize': {
          // 区间（chapter_end，2026-10-02）：串行启动闭区间每一章；
          // 中途失败按既有错误映射返回（已启动的章节不回滚——run 已进入 activeRuns；回执即返回，不等 run 结束）
          if (chapterEnd !== undefined) {
            const started: { runId: string; displayName: string; chapterTag: string }[] = []
            try {
              for (let n = chapterNumber!; n <= chapterEnd; n++) {
                assertActive()
                started.push(await startChapterWorkflow(workflow as 'generate_draft' | 'review' | 'refine' | 'finalize', n, context ? { ...context, operationId: `${context.operationId}:chapter:${n}` } : undefined))
              }
            } catch (e) {
              if (e instanceof ToolExecutionInterrupted && started.length > 0) return {
                success: false,
                executionState: 'committed',
                content: '',
                error: `区间启动已中断；已启动：${started.map(r => r.chapterTag).join('、')}，不得重复启动。`,
                artifacts: started.map((r, index) => ({ type: 'workflow_started' as const, name: `${r.displayName} ${r.chapterTag}`, metadata: { runId: r.runId, workflow, chapterNumber: chapterNumber! + index } })),
              }
              // 部分失败（2026-10-02 评审 I3）：已启动清单并入错误——否则模型会重发整个区间（重复启动/重复花费）
              if (e instanceof WorkflowStartError && started.length > 0) {
                const startedTags = started.map(r => r.chapterTag).join('、')
                throw new WorkflowStartError(e.code, `${e.message}${t('tool.wfRangePartial').replace('{started}', startedTags)}`)
              }
              throw e
            }
            return {
              success: true,
              content: started.map(r =>
                t('tool.workflowStarted').replace('{name}', r.displayName).replace('{chapter}', r.chapterTag),
              ).join('\n'),
              artifacts: started.map((r, index) => ({ type: 'workflow_started' as const, name: `${r.displayName} ${r.chapterTag}`, metadata: { runId: r.runId, workflow, chapterNumber: chapterNumber! + index } })),
            }
          }
          const result = await startChapterWorkflow(
            workflow as 'generate_draft' | 'review' | 'refine' | 'finalize',
            chapterNumber!,
            context,
          )
          return {
            success: true,
            executionState: 'committed',
            content: t('tool.workflowStarted').replace('{name}', result.displayName).replace('{chapter}', result.chapterTag),
            artifacts: [{ type: 'workflow_started', name: `${result.displayName} ${result.chapterTag}`, metadata: { runId: result.runId, workflow, chapterNumber } }],
          }
        }
        case 'generate_blueprint': {
          const result = await startBlueprintWorkflow(context, { chapterNumber, chapterEnd })
          const rangeTitle = t('tool.wfBlueprintRangeTitle')
            .replace('{start}', String(result.chapterNumber)).replace('{end}', String(result.chapterEnd))
          return {
            success: true,
            executionState: 'committed',
            content: t('tool.workflowStartedNoChapter').replace('{name}', rangeTitle),
            artifacts: [{ type: 'workflow_started', name: rangeTitle, metadata: { runId: result.runId, workflow, chapterNumber: result.chapterNumber, chapterEnd: result.chapterEnd } }],
          }
        }
        case 'generate_architecture': {
          const result = await startArchitectureWorkflow(context)
          return {
            success: true,
            executionState: 'committed',
            content: t('tool.workflowStartedNoChapter').replace('{name}', result.displayName),
            artifacts: [{ type: 'workflow_started', name: result.displayName, metadata: { runId: result.runId, workflow } }],
          }
        }
        case 'config_generation': {
          // 线③ 第 4 条：Agent 起配置生成——需要「创作脑洞」作为唯一输入
          if (!idea) {
            return { success: false, content: '', error: t('tool.wfNeedIdea') }
          }
          const result = await startConfigGenerationWorkflow(idea, context)
          return {
            success: true,
            executionState: 'committed',
            content: t('tool.workflowStartedNoChapter').replace('{name}', result.displayName),
            artifacts: [{ type: 'workflow_started', name: result.displayName, metadata: { runId: result.runId, workflow } }],
          }
        }
        default:
          return { success: false, content: '', error: t('tool.wfUnsupported').replace('{workflow}', workflow) }
      }
    } catch (e) {
      if (e instanceof WorkflowStartError) {
        // P0-3 错误语义统一：按 code 映射回用户可见文案，零用户可见变化——
        // - ERR_GUARD：e.message 即 guard.message || error.prereqNotMet（保留 guard 细分文案）
        // - ERR_NO_DRAFT：按 workflow 映射回三细分键（tool.wfNoDraft 键不存在，文案保留细分）；
        // - ERR_NO_BLUEPRINT：e.message 已带 wfBlueprintDataMissing 文案（buildDraftWorkflow 内 throw）
        const msg = e.code === 'ERR_GUARD'
          ? (e.message || t('error.prereqNotMet'))
          : e.code === 'ERR_NO_DRAFT'
            // 2026-10-02（区间配套）：优先透传 e.message——workflow-starter 已按 workflow + 实际章号参数化；
            // 区间调用下 chapterNumber 只是起始章，重建文案会把「第6章无草稿」误报成「第5章」。
            // 空 message 兜底回重建（仅防御——starter 抛出的 message 恒非空）
            ? (e.message || (workflow === 'review' ? t('tool.wfNoReviewDraft')
              : workflow === 'refine' ? t('tool.wfNoRefineDraft')
              : t('tool.wfNoFinalizeDraft')).replace('{chapter}', String(chapterNumber)))
            : e.message
        return { success: false, content: '', error: msg }
      }
      // 非 WorkflowStartError 异常继续上抛（agent-engine 负责兜底展示）
      throw e
    }
  },
})
