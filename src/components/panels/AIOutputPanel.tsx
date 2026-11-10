import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getCurrentLocale } from '../../shared/locale'
import { CheckCircle2, Circle, Sparkles, X, ChevronRight, StopCircle, Play, HardDrive, Pause, RotateCcw, Maximize2, Minimize2, Trash2 } from 'lucide-react'
import { createPortal } from 'react-dom'
import { Spinner } from '../ui/Spinner'
import { useWorkflowStore, type WorkflowRun, type WorkflowStep } from '../../stores/workflow-store'
import { useLayoutStore } from '../../stores/layout-store'
import MarkdownContent from '../ui/MarkdownContent'
import { useTranslation } from '../../hooks/useTranslation'
import { useOutputFileTail } from '../../hooks/useOutputFileTail'
import { cleanupMessageText } from '../../services/agent/conversation-recovery'

/**
 * 右侧面板「AI 输出」视图
 * 参考 Cursor Agent 风格：扁平化、极简文字驱动、可折叠思考区
 */
export default function AIOutputPanel() {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [showList, setShowList] = useState(false)
  const fullscreenButton = useRef<HTMLButtonElement>(null)
  const inlineHost = useRef<HTMLDivElement>(null)
  const [portalHost] = useState(() => document.createElement('div'))
  useLayoutEffect(() => {
    portalHost.style.height = '100%'
    const parent = expanded ? document.body : inlineHost.current
    parent?.appendChild(portalHost)
    return () => { portalHost.remove() }
  }, [expanded, portalHost])
  useEffect(() => {
    if (!expanded) return
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setExpanded(false) }
    }
    document.addEventListener('keydown', keydown)
    fullscreenButton.current?.focus()
    return () => document.removeEventListener('keydown', keydown)
  }, [expanded])
  // ✅ 使用 selector 精确订阅，避免 globalLogs 高频更新导致整个面板重渲染
  const activeRuns = useWorkflowStore(s => s.activeRuns)
  const history = useWorkflowStore(s => s.history)
  const getActiveStreamingRun = useWorkflowStore(s => s.getActiveStreamingRun)
  const activeRun = getActiveStreamingRun()
  const viewRunId = useWorkflowStore(s => s.selectedRunId)
  const setViewRunId = useWorkflowStore(s => s.selectRun)

  // 开发环境日志（生产环境自动移除）
  if (import.meta.env.DEV) {
    console.debug('[AIOutputPanel] render: activeRuns=', activeRuns.length, 'activeRun=', activeRun?.status)
  }

  // 自动跟随最新活跃任务
  useEffect(() => {
    if (activeRun) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (useWorkflowStore.getState().selectedRunId === null) setViewRunId(activeRun.id)
      return
    }
    // M2 崩溃恢复续读：无活跃流时仅当用户尚未选择任何视图（viewRunId===null）才自动选中
    // 恢复回来的 paused/failed run（其步骤输出可能只存在于磁盘 workflow-output 文件，需在面板内
    // 可见才能触发文件轮询查看）——M-5：一旦用户浏览了历史/其他 run，不再把视图抢回
    const recovered = activeRuns.find(r => r.status === 'paused' || r.status === 'failed')
    if (recovered) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (useWorkflowStore.getState().selectedRunId === null) setViewRunId(recovered.id)
    }
  }, [activeRun?.id, activeRun, activeRuns, setViewRunId])

  const viewRun: WorkflowRun | undefined =
    activeRuns.find(r => r.id === viewRunId) ||
    history.find(r => r.id === viewRunId) ||
    activeRun ||
    undefined

  const recentHistory = history.slice(0, 10)

  const panel = (
    <div
      role={expanded ? 'dialog' : undefined}
      aria-label={t('agent.aiOutput')}
      className={expanded ? 'fixed inset-0 z-[1000] flex flex-col overflow-hidden' : 'flex flex-col h-full overflow-hidden'}
      style={{
        backgroundColor: 'var(--color-sidebar)',
        borderLeft: '1px solid var(--color-border)',
      }}
    >
      {/* 面板头部 */}
      <div
        className="no-select flex items-center justify-between gap-1.5 px-2 flex-shrink-0"
        style={{
          height: expanded ? 64 : 'var(--height-panel-header)',
          minHeight: expanded ? 64 : 36,
          paddingTop: expanded ? 24 : undefined,
          borderBottom: '1px solid var(--color-border)',
        }}
      >
        <span
          className="text-xs font-medium"
          style={{ color: 'var(--color-text-muted)' }}
        >
          {t('agent.aiOutput')}
        </span>
        <div className="flex items-center gap-1">
          {viewRun && !showList && <button className="icon-btn" style={{ width: 'auto', padding: '0 8px' }} title={t('workflow.backToTasks')} aria-label={t('workflow.backToTasks')} onClick={() => setShowList(true)}><ChevronRight className="rotate-180" size={15} /><span className="ml-1 text-xs">{t('workflow.taskList')}</span></button>}
          <button ref={fullscreenButton} onClick={() => setExpanded(value => !value)} title={t(expanded ? 'workflow.exitFullscreen' : 'workflow.fullscreen')} aria-label={t(expanded ? 'workflow.exitFullscreen' : 'workflow.fullscreen')} className="icon-btn" style={{ width: expanded ? 'auto' : 28, height: 32, padding: expanded ? '0 10px' : undefined, WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            {expanded ? <><Minimize2 size={15} /><span className="ml-2 text-xs">{t('workflow.exitFullscreen')}</span></> : <Maximize2 size={15} />}
          </button>
          <button
            onClick={() => expanded ? setExpanded(false) : useLayoutStore.getState().setAIPanelOpen(false)}
            title={t('action.close')}
            aria-label={t('action.close')}
            className="icon-btn"
            style={{ width: 28, height: 28 }}
          >
            <X size={13} strokeWidth={1.5} />
          </button>
        </div>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-hidden">
        {viewRun && !showList ? (
          <ActiveRunView
            run={viewRun}
            activeRuns={activeRuns}
            onSwitchRun={setViewRunId}
          />
        ) : (
          <div className="h-full overflow-y-auto">
            {recentHistory.length === 0 && activeRuns.length === 0 ? (
              <EmptyState />
            ) : (
              <div className="px-3 py-3">
                <HistoryList items={[...activeRuns, ...recentHistory]} onSelect={id => { setViewRunId(id); setShowList(false) }} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
  return <div ref={inlineHost} className="h-full">{createPortal(panel, portalHost)}</div>
}


// ===== 空状态 =====

function EmptyState() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col items-center justify-center h-full gap-2 px-6" style={{ color: 'var(--color-text-muted)' }}>
      <Sparkles size={20} style={{ opacity: 0.2 }} />
      <span className="text-xs opacity-60">{t('agent.noOutput')}</span>
    </div>
  )
}


// ===== 活跃任务视图（Cursor 风格） =====

function ActiveRunView({
  run,
  activeRuns,
  onSwitchRun,
}: {
  run: WorkflowRun
  activeRuns: WorkflowRun[]
  onSwitchRun: (id: string) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const isActive = run.status === 'running' || run.status === 'waiting'
  const canResume = run.status === 'paused' && activeRuns.some(r => r.id === run.id)
  const isDirectory = run.type === 'directory'
  const canContinueSaved = isDirectory && !isActive && run.status !== 'completed'
  const [controlBusy, setControlBusy] = useState(false)
  const control = async (action: () => Promise<void>) => {
    if (controlBusy) return
    setControlBusy(true)
    try { await action() } catch (error) { window.alert(String(error)) } finally { setControlBusy(false) }
  }
  // M2：崩溃恢复回来的 paused/failed run（仅 activeRuns 内）——其空 result 步骤可从磁盘
  // workflow-output 文件续读（组件挂载/展开才 1s 轮询 tail，不可见即停）
  const isRecoveredRun = activeRuns.some(r => r.id === run.id) && (run.status === 'paused' || run.status === 'failed')
  const cancelWorkflow = useWorkflowStore.getState().cancelWorkflow
  // 等待确认状态（与 BottomPanel 同源）：任务挂起等待用户确认下一步时提供「继续执行」
  const waitingRuns = useWorkflowStore(s => s.waitingRuns)
  const confirmContinue = useWorkflowStore(s => s.confirmContinue)
  const runWaiting = waitingRuns[run.id]
  const waitingForConfirm = runWaiting?.waitingForConfirm ?? false
  const prevLenRef = useRef(0)
  const { t } = useTranslation()

  // 提取当前步骤 + 内容
  const currentStep = run.steps[run.currentStepIndex] || run.steps[0]
  const rawText = currentStep?.result || ''

  let content = rawText
  const segments = rawText.split(/<think>/)
  if (segments.length > 1) {
    const lastSegment = segments[segments.length - 1]
    const end = lastSegment.indexOf('</think>')
    if (end !== -1) {
      content = lastSegment.substring(end + 8)
    } else {
      content = ''
    }
  }

  // 节流自动滚动：仅在正文内容长度变化时触发，思考区不自动滚动
  const contentLen = content.length
  useEffect(() => {
    if (!autoScroll || !scrollRef.current) return
    if (contentLen !== prevLenRef.current) {
      prevLenRef.current = contentLen
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        }
      })
    }
  }, [contentLen, autoScroll, run.currentStepIndex])

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 60)
  }

  // 整体进度百分比
  const completedCount = run.steps.filter(s => s.status === 'completed').length
  const overallProgress = run.steps.length > 0
    ? Math.round(((completedCount + (currentStep?.progress || 0) / 100) / run.steps.length) * 100)
    : 0

  return (
    <div className="flex flex-col h-full overflow-hidden relative">
      {/* 多任务切换（多于1个任务时显示） */}
      {(activeRuns.length > 1 || (activeRuns.length === 1 && activeRuns[0].id !== run.id)) && (
        <div
          className="flex items-center gap-1 px-2 py-1.5 flex-shrink-0 overflow-x-auto"
          style={{ borderBottom: '1px solid var(--color-border)' }}
        >
          {activeRuns.map(r => (
            <button
              key={r.id}
              onClick={() => onSwitchRun(r.id)}
              className="text-micro px-2 py-0.5 rounded transition-all flex-shrink-0"
              style={{
                backgroundColor: r.id === run.id ? 'var(--color-hover)' : 'transparent',
                color: r.id === run.id ? 'var(--color-text)' : 'var(--color-text-muted)',
              }}
            >
              {r.title.replace(/^[^\s]+\s/, '')}
            </button>
          ))}
        </div>
      )}

      {/* 整体进度条（细线） */}
      <div className="flex-shrink-0" style={{ height: 2, backgroundColor: 'var(--color-border)' }}>
        <div
          style={{
            height: '100%',
            width: `${Math.max(isActive ? 3 : 0, overallProgress)}%`,
            backgroundColor: run.status === 'completed' ? 'var(--color-success)' : 'var(--color-accent)',
            borderRadius: 1,
            transition: 'width 0.6s ease',
          }}
        />
      </div>

      {/* 滚动内容区 */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
      >
        {/* 步骤进度区及独立输出流 */}
        <div className="px-2 pt-2 pb-4">
          {run.steps.map((step, i) => (
            <StepOutputBlock
              key={step.id}
              step={step}
              index={i}
              total={run.steps.length}
              isActiveRun={isActive}
              isCurrentStep={i === run.currentStepIndex}
              recoverRunId={isRecoveredRun ? run.id : null}
            />
          ))}

          {/* 全局完成状态（所有步骤走完之后展示） */}
          {!isActive && run.status === 'completed' && (
            <div
              className="flex items-center justify-center gap-1.5 pt-4 pb-2 mb-2 text-xs"
              style={{ color: 'var(--color-success)', borderTop: '1px dashed var(--color-border)' }}
            >
              <CheckCircle2 size={12} />
              {t('agent.workflowComplete')}
            </div>
          )}
        </div>

        {/* 底部操作占位符，避免滚动到底部被遮挡 */}
        {isActive && <div className="h-10 w-full flex-shrink-0" />}
      </div>

      {/* 固定在底部的操作悬浮区 — 等待确认时提供「继续执行」（与底部任务面板一致） */}
      {(isActive || canResume || isDirectory) && (
        <div role="toolbar" aria-label={t('agent.aiOutput')} className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-sidebar)] p-1 shadow-[var(--shadow-md)]">
          {isDirectory && isActive && (
            <button className="icon-btn" style={{ width: 32, height: 32 }} onClick={() => useWorkflowStore.getState().pauseWorkflow(run.id)} title={t('workflow.pauseBlueprintHint')} aria-label={t('workflow.pauseBlueprint')}><Pause size={16} /></button>
          )}
          {(waitingForConfirm || canResume || canContinueSaved) && (
            <button className="icon-btn" style={{ width: 32, height: 32, color: 'var(--color-accent)' }} disabled={controlBusy || !!run.pauseRequested} title={t('workflow.continueBlueprint')} aria-label={t('workflow.continueBlueprint')} onClick={() => {
              if (canContinueSaved) void control(() => useWorkflowStore.getState().continueDirectory(run.id))
              else confirmContinue(run.id)
            }}><Play size={16} /></button>
          )}
          {isDirectory && (
            <button className="icon-btn" style={{ width: 32, height: 32 }} disabled={controlBusy || !!run.pauseRequested} title={t('workflow.restartBlueprint')} aria-label={t('workflow.restartBlueprint')} onClick={() => {
              if (window.confirm(t('workflow.restartBlueprintConfirm'))) void control(() => useWorkflowStore.getState().restartWorkflow(run.id))
            }}><RotateCcw size={16} /></button>
          )}
          {(isActive || canResume) && (
            <button className="icon-btn" style={{ width: 32, height: 32 }} disabled={controlBusy} title={t('agent.abortGen')} aria-label={t('agent.abortGen')} onClick={() => cancelWorkflow(run.id)}><StopCircle size={16} /></button>
          )}
          {(controlBusy || run.pauseRequested) && <span role="status" title={t('workflow.stoppingBlueprint')}><Spinner size={14} /></span>}
        </div>
      )}
    </div>
  )
}


// ===== 新版渲染单步结果（支持查看所有历史步骤数据） =====
function StepOutputBlock({ step, index, total, isActiveRun, isCurrentStep, recoverRunId }: {
  step: WorkflowStep
  index: number
  total: number
  isActiveRun: boolean
  isCurrentStep: boolean
  /** M2：崩溃恢复 run（paused/failed，在 activeRuns 内）→ 该 runId 下 result 为空的步骤
   *  可从磁盘输出文件续读（useOutputFileTail：组件展开才轮询 tail，折叠/卸载即停） */
  recoverRunId?: string | null
}) {
  const { t } = useTranslation()
  const isRunning = step.status === 'running'
  const isCompleted = step.status === 'completed'
  const isFailed = step.status === 'failed'

  // 防御：step.result 可能不是字符串（如 Command 返回了数组/对象），强制转为字符串
  const rawText = typeof step.result === 'string' ? step.result : (step.result ? JSON.stringify(step.result) : '')
  let thinking = ''
  let content = rawText

  const segments = rawText.split(/<think>/)
  if (segments.length > 1) {
    const lastSegment = segments[segments.length - 1]
    const end = lastSegment.indexOf('</think>')
    if (end !== -1) {
      thinking = lastSegment.substring(0, end)
      content = lastSegment.substring(end + 8)
    } else {
      thinking = lastSegment
      content = ''
    }
  }

  // 当前激活的步骤默认展开，过去/未来的默认折叠（只有产生了内容的步骤才允许展开）
  const [expanded, setExpanded] = useState(isCurrentStep)

  // M2 文件续读轮询：仅当「恢复 run + 本步无内存内容 + 本步展开可见」才启用（挂载门控，
  // 折叠/切换 run/卸载 → enabled=false → 停轮询）；正在流式的步骤走内存渲染，不参与
  const fileTail = useOutputFileTail({
    runId: recoverRunId ?? '',
    stepIndex: index,
    enabled: Boolean(recoverRunId && !rawText && expanded),
  })
  // M-2：恢复区渲染前过 cleanupMessageText 净化（与 hydrate 补填 step.result 同语义——
  // 文件是流式原文镜像，可能带半截 <think>/<tool_call> 残片，直接渲染会闪现脏文本）
  const recoveredContent = expanded && !rawText && fileTail.exists ? cleanupMessageText(fileTail.content) : ''

  // 监听如果步骤被激活，则自动展开
  useEffect(() => {
    let mounted = true
    if (isCurrentStep) {
      Promise.resolve().then(() => {
        if (mounted) setExpanded(true)
      })
    }
    return () => { mounted = false }
  }, [isCurrentStep])

  // 头部是否可点击展开/收起：有内存内容 或 崩溃恢复步骤（磁盘可能仍有中断输出）
  const revealable = Boolean(rawText) || Boolean(recoverRunId && !rawText)

  return (
    <div className="mb-1.5">
      {/* 头部摘要项，点击折叠/展开 */}
      <div
        onClick={() => { if (revealable) setExpanded(!expanded) }}
        className="flex items-center gap-2 px-2 py-1.5 rounded-md text-xs transition-colors"
        style={{
          cursor: revealable ? 'pointer' : 'default',
          backgroundColor: isRunning ? 'var(--color-hover)' : 'transparent',
          color: isRunning ? 'var(--color-text)' :
                 isCompleted ? 'var(--color-text-secondary)' :
                 isFailed ? 'var(--color-error)' :
                 'var(--color-text-muted)',
        }}
        title={revealable ? t('agent.stepHistoryTip') : undefined}
      >
        {/* 状态图标 */}
        <span className="flex-shrink-0 w-4 flex justify-center">
          {isCompleted && <CheckCircle2 size={11} style={{ color: 'var(--color-success)' }} />}
          {isRunning && <Spinner size={11}  style={{ color: 'var(--color-accent)' }} />}
          {isFailed && <Circle size={11} style={{ color: 'var(--color-error)', fill: 'var(--color-error)' }} />}
          {(step.status === 'pending' || step.status === 'skipped') && (
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ backgroundColor: 'var(--color-border)' }}
            />
          )}
        </span>

        {/* 步骤名 */}
        <span className="truncate flex-1" style={{ fontWeight: isRunning ? 500 : 400 }}>
          {step.name}
        </span>

        {/* 进度 */}
        {isRunning && step.progress !== undefined && (
          <span className="font-mono text-2xs flex-shrink-0 opacity-60">
            {step.progress}%
          </span>
        )}

        {/* 展开角标或序号 */}
        {((rawText || recoverRunId) && !isRunning) ? (
          <ChevronRight
            size={11}
            style={{
              transition: 'transform 0.2s',
              transform: expanded ? 'rotate(90deg)' : 'none',
              opacity: 0.4,
            }}
          />
        ) : (
          <span className="font-mono text-2xs flex-shrink-0 opacity-30">
            {index + 1}/{total}
          </span>
        )}
      </div>

      {isFailed && step.error && (
        <div role="alert" className="mx-2 my-2 rounded-md border border-[var(--color-error)] p-3 text-xs break-words" style={{ color: 'var(--color-error)' }}>
          <div className="whitespace-pre-wrap select-text">{step.error}</div>
          {rawText && <p className="mt-2">{t('workflow.partialOutput')}</p>}
          {step.errorDetail && (
            <details className="mt-2">
              <summary className="cursor-pointer">{t('workflow.errorDetails')}</summary>
              <pre className="mt-2 whitespace-pre-wrap select-text font-mono text-micro">{step.errorDetail}</pre>
            </details>
          )}
        </div>
      )}

      {/* 展开的对应输出数据 */}
      {expanded && rawText && (
        <div className="pl-[4px] pr-1 pt-1 pb-3 text-xs w-full max-w-full break-words">
          {/* 思维链区域 */}
          {thinking && (
            <ThinkingBlock
              thinking={thinking}
              showCursor={isRunning && isActiveRun && !content}
              hasContent={!!content}
            />
          )}

          {/* 实际正文区域 */}
          {content && (
            <div className="mt-1">
              <MarkdownContent content={content} streaming={isRunning && isActiveRun} />
            </div>
          )}
        </div>
      )}

      {/* M2：崩溃恢复续读区——步骤中断时内存 result 为空，但磁盘输出文件仍在：
          组件展开可见才轮询（1s tail），读到内容以「已从磁盘恢复」标注渲染 */}
      {recoveredContent && (
        <div className="pl-[4px] pr-1 pt-1 pb-3 text-xs w-full max-w-full break-words">
          <div
            className="flex items-center gap-1.5 mb-1.5 text-micro"
            style={{ color: 'var(--color-text-muted)', opacity: 0.85 }}
          >
            <HardDrive size={10} />
            <span>{t('agent.outputRecovered')}</span>
            {fileTail.truncated && <span className="opacity-70">({t('agent.outputTailOnly')})</span>}
          </div>
          <MarkdownContent content={recoveredContent} streaming={false} />
        </div>
      )}

      {/* 如果是单一正在执行等待，则显示一个等待骨架 */}
      {!rawText && isRunning && isActiveRun && (
        <div className="pl-[4px] pr-1 pt-1 pb-3 text-xs text-center" style={{ color: 'var(--color-text-muted)', opacity: 0.7 }}>
          {t('agent.waitingResponse')}
        </div>
      )}
    </div>
  )
}


// ===== 思考区块（Cursor "Worked for" 风格） =====

function ThinkingBlock({ thinking, showCursor, hasContent }: { thinking: string; showCursor: boolean; hasContent: boolean }) {
  const { t } = useTranslation()
  // 正文未开始时默认展开，正文开始后默认关闭
  const [expanded, setExpanded] = useState(!hasContent)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let mounted = true
    if (hasContent) {
      Promise.resolve().then(() => {
        if (mounted) setExpanded(false)
      })
    }
    return () => { mounted = false }
  }, [hasContent])

  useEffect(() => {
    if (expanded && scrollRef.current) {
      const el = scrollRef.current
      // 只有在用户没有往上滚拉太多时，才自动贴近底部
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) {
        // 使用 requestAnimationFrame 确保在 DOM 更新后执行
        requestAnimationFrame(() => {
          if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight
          }
        })
      }
    }
  }, [thinking, expanded])

  return (
    <div className="mb-0.5">
      {/* 可折叠标题按钮 — 参考 Cursor 的 "Worked for Xm" */}
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="group flex items-center gap-1.5 w-full text-left text-xs min-h-6 py-1 select-none transition-colors"
        style={{ color: 'var(--color-text-muted)', opacity: 0.8 }}
        onMouseEnter={e => { e.currentTarget.style.color = 'var(--color-text)' }}
        onMouseLeave={e => { e.currentTarget.style.color = 'var(--color-text-muted)' }}
      >
        <ChevronRight
          size={12}
          style={{
            transition: 'transform 0.2s',
            transform: expanded ? 'rotate(90deg)' : 'none',
          }}
        />
        <span>
          {showCursor ? t('agent.thinking') : t('agent.thinkingToggle')}
        </span>
        {showCursor && !expanded && (
          <span className="ai-stream-cursor" style={{ height: 11, width: 3 }} />
        )}
      </button>

      {/* 展开的思考内容 */}
      {expanded && (
        <div
          ref={scrollRef}
          className="ml-0.5 pl-3 border-l-2 py-0.5 mb-2 mt-1 text-xs leading-relaxed whitespace-pre-wrap overflow-y-auto"
          style={{
            borderColor: 'var(--color-border)',
            color: 'var(--color-text-muted)',
            maxHeight: 250,
            fontFamily: 'var(--font-mono)',
            lineHeight: 1.6,
          }}
        >
          {thinking}
          {showCursor && <span className="ai-stream-cursor" style={{ height: 12, width: 3 }} />}
        </div>
      )}
    </div>
  )
}


// ===== 历史列表 =====

function HistoryList({ items, onSelect }: { items: WorkflowRun[]; onSelect: (id: string) => void }) {
  const { t } = useTranslation()
  const activeRuns = useWorkflowStore(s => s.activeRuns)
  const [deleting, setDeleting] = useState<string | null>(null)
  const remove = async (id: string) => {
    if (deleting || !window.confirm(t('workflow.deleteHistoryConfirm'))) return
    setDeleting(id)
    try { await useWorkflowStore.getState().deleteHistory(id) } catch (error) { window.alert(String(error)) } finally { setDeleting(null) }
  }
  return (
    <div>
      <p
        className="text-micro font-medium mb-2 px-1"
        style={{ color: 'var(--color-text-muted)', opacity: 0.7 }}
      >
        {t('agent.history')}
      </p>
      <div className="flex flex-col gap-0.5">
        {items.map(run => (
          <div key={run.id} className="flex items-center gap-1">
          <button
            onClick={() => onSelect(run.id)}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors"
            onMouseEnter={e => { e.currentTarget.style.backgroundColor = 'var(--color-hover)' }}
            onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent' }}
          >
            {run.status === 'completed'
              ? <CheckCircle2 size={10} style={{ color: 'var(--color-success)', flexShrink: 0, opacity: 0.6 }} />
              : <Circle size={10} style={{ color: 'var(--color-error)', flexShrink: 0, opacity: 0.6 }} />
            }
            <span className="text-xs truncate flex-1" style={{ color: 'var(--color-text-secondary)' }}>
              {run.title.replace(/^[^\s]+\s/, '')}
            </span>
            <span className="text-2xs flex-shrink-0 font-mono opacity-30">
              {new Date(run.createdAt).toLocaleTimeString(getCurrentLocale(), { hour: '2-digit', minute: '2-digit' })}
            </span>
          </button>
          <button className="icon-btn shrink-0" disabled={deleting !== null || activeRuns.some(r => r.id === run.id)} title={t(activeRuns.some(r => r.id === run.id) ? 'workflow.deleteHistoryBusy' : 'workflow.deleteHistory')} aria-label={t('workflow.deleteHistory')} onClick={() => void remove(run.id)}>
            {deleting === run.id ? <Spinner size={13} /> : <Trash2 size={13} />}
          </button>
          </div>
        ))}
      </div>
    </div>
  )
}
