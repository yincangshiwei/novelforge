// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const h = vi.hoisted(() => ({ continueDirectory: vi.fn(async () => {}), restartWorkflow: vi.fn(async () => {}), close: vi.fn() }))
vi.mock('../../stores/workflow-store', () => {
  const run = { id: 'old', type: 'directory', title: '蓝图', status: 'failed', steps: [{ id: 'failed-step', name: '生成蓝图', status: 'failed', error: '模型连接异常结束', errorDetail: 'runId=old requestId=req-1', logs: [] }], currentStepIndex: 0 }
  const state = { activeRuns: [], history: [run], getActiveStreamingRun: () => null, selectedRunId: 'old', selectRun: vi.fn(), waitingRuns: {}, confirmContinue: vi.fn(), cancelWorkflow: vi.fn(), ...h }
  const store = Object.assign((selector: (s: typeof state) => unknown) => selector(state), { getState: () => state })
  return { useWorkflowStore: store }
})
vi.mock('../../stores/layout-store', () => ({ useLayoutStore: { getState: () => ({ setAIPanelOpen: h.close }) } }))
vi.mock('../../hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key === 'workflow.blueprintResumeProgress' ? 'saved={count};last={last};next={next}' : key }) }))
vi.mock('../ui/MarkdownContent', () => ({ default: () => null }))
vi.mock('../../hooks/useOutputFileTail', () => ({ useOutputFileTail: () => ({ text: '', loading: false }) }))
import AIOutputPanel from './AIOutputPanel'
import { useWorkflowStore } from '../../stores/workflow-store'
let cleanup: (() => void) | undefined
afterEach(() => { cleanup?.(); document.body.innerHTML = ''; vi.clearAllMocks() })
function render() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(<AIOutputPanel />))
  cleanup = () => act(() => root.unmount())
  return container
}
it.each([undefined, 176])('输出停在175时按本任务断点显示179保存进度及真实缺章 %s', missing => {
  const run = useWorkflowStore.getState().history[0]
  const previous = run.resumeData
  run.resumeData = { directoryStart: 1, directoryEnd: 368,
    newBlueprints: Array.from({ length: 179 }, (_, i) => ({ chapterNumber: i + 1 })).filter(b => b.chapterNumber !== missing) }
  try {
    render()
    const text = document.querySelector('[role="status"]')?.textContent
    expect(text).toBe(missing ? 'saved=178;last=175;next=176' : 'saved=179;last=179;next=180')
  } finally { run.resumeData = previous }
})

it('无生成正文时错误原因和诊断仍直接可见', () => {
  render()
  const alert = document.querySelector('[role="alert"]')!
  expect(alert.textContent).toContain('模型连接异常结束')
  expect(alert.querySelector('details')?.textContent).toContain('requestId=req-1')
})
it('已终止蓝图显示纯图标继续生成，操作不是从头重生成', async () => {
  render()
  const button = document.querySelector('[aria-label="workflow.continueBlueprint"]') as HTMLButtonElement
  expect(button).not.toBeNull()
  expect(button.textContent).toBe('')
  expect(button.title).toBe('workflow.continueBlueprint')
  await act(async () => { button.click() })
  expect(h.continueDirectory).toHaveBeenCalledWith('old')
  expect(h.restartWorkflow).not.toHaveBeenCalled()
})
it('全屏复用同一个输出视图，Esc返回侧栏而不关闭输出', () => {
  const container = render()
  const toolbar = document.querySelector('[role="toolbar"]')
  act(() => (document.querySelector('[aria-label="workflow.fullscreen"]') as HTMLButtonElement).click())
  const dialog = document.querySelector('[role="dialog"]')!
  expect(container.contains(dialog)).toBe(false)
  expect(document.querySelector('[role="toolbar"]')).toBe(toolbar)
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(container.contains(toolbar)).toBe(true)
  expect(h.close).not.toHaveBeenCalled()
})
it('输出详情可返回任务列表，全屏退出按钮有明确文字且不关闭软件', () => {
  render()
  act(() => (document.querySelector('[aria-label="workflow.backToTasks"]') as HTMLButtonElement).click())
  expect(document.querySelector('[role="toolbar"]')).toBeNull()
  act(() => (document.querySelector('[aria-label="workflow.fullscreen"]') as HTMLButtonElement).click())
  const exit = document.querySelector('[aria-label="workflow.exitFullscreen"]') as HTMLButtonElement
  expect(exit.textContent).toContain('workflow.exitFullscreen')
  act(() => exit.click())
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(h.close).not.toHaveBeenCalled()
})
