// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ReviewReport from './ReviewReport'
import { reviewContentHash } from '../../services/review-actions'
import { useEditorStore } from '../../stores/editor-store'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore } from '../../stores/workflow-store'

const mock = vi.hoisted(() => ({ invoke: vi.fn(), start: vi.fn(), create: vi.fn(), confirm: vi.fn() }))
vi.mock('../../services/ipc-client', () => ({ ipc: { invoke: mock.invoke } }))
vi.mock('../../services/workflows/workflow-starter', () => ({ startWithReceipt: mock.start }))
vi.mock('../../services/workflows/chapter-workflow', () => ({
  parseDraftMeta: async () => ({ id: 42, chapterNumber: 1, version: 1, status: 'draft' }),
  createRefineFromReviewWorkflow: mock.create,
}))
vi.mock('../ui/Confirm', () => ({ confirm: mock.confirm }))
vi.mock('./AIActionDialog', () => ({ default: ({ action, onConfirm }: { action: string | null; onConfirm: () => void }) => action ? <button onClick={onConfirm}>确认修稿</button> : null }))
let root: Root
let container: HTMLDivElement
const draft = '前文。原始片段。后文。'
async function render(quote = '不存在的引用', extra = {}) {
  const report = JSON.stringify({ baseDraftId: 42, baseContentHash: await reviewContentHash(draft), items: [
    { category: '文风', severity: 'warning', quote, description: '修改这个问题' },
    { category: '剧情', severity: 'pass', description: '通过' },
  ], ...extra })
  await act(async () => root.render(<ReviewReport reportText={report} draftPath="vela://draft/42" />))
}
async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === text)!
  await act(async () => { button.click() })
  await vi.waitFor(async () => {
    await act(async () => { await vi.dynamicImportSettled() })
    expect(button.disabled).toBe(false)
  })
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('crypto', webcrypto)
  vi.clearAllMocks()
  mock.invoke.mockResolvedValue({ content: draft })
  mock.confirm.mockResolvedValue(true)
  mock.start.mockResolvedValue({})
  mock.create.mockImplementation(params => params)
  useEditorStore.setState({ tabs: [], activeTabId: null })
  useProjectStore.setState({ currentProject: { id: 'p1', path: '/mock' } as never })
  useWorkflowStore.setState({ activeRuns: [] })
  localStorage.clear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

describe('审稿后直接AI修复', () => {
  it('底部AI修复确认不将点击事件当成问题数组，无效引用也能按报告启动', async () => {
    await render()
    await click('AI 一键修稿')
    await click('确认修稿')
    expect(mock.start).toHaveBeenCalledOnce()
    expect(mock.create.mock.calls[0][0].localOnly).toBe(false)
    expect(JSON.parse(mock.create.mock.calls[0][0].reviewReport).items).toHaveLength(1)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
  it('有效引用仍走精确局部修复', async () => {
    await render('原始片段')
    await click('AI修复此项')
    expect(mock.create.mock.calls[0][0].localOnly).toBe(true)
    expect(mock.confirm).not.toHaveBeenCalled()
  })
  it('无效局部引用经确认转为章节级修稿，只包含选中建议且不再审稿', async () => {
    await render()
    await click('AI修复此项')
    expect(mock.confirm.mock.calls[0][0]).toContain('无需重新审稿')
    expect(mock.confirm.mock.calls[0][0]).toContain('修改这个问题')
    expect(mock.confirm.mock.calls[0][0]).toContain('与正文不匹配')
    expect(mock.create.mock.calls[0][0].localOnly).toBe(false)
    expect(JSON.parse(mock.create.mock.calls[0][0].reviewReport).items).toHaveLength(1)
    expect(mock.start).toHaveBeenCalledOnce()
  })
  it('取消扩大修稿范围不启动任务', async () => {
    mock.confirm.mockResolvedValue(false)
    await render()
    await click('AI修复此项')
    expect(mock.start).not.toHaveBeenCalled()
  })
  it('选中修复同样能处理无效引用', async () => {
    await render()
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    await click('AI修复选中项（精确局部）')
    expect(mock.confirm).toHaveBeenCalledOnce()
    expect(mock.create.mock.calls[0][0].localOnly).toBe(false)
  })
  it('同一渲染周期快速连点只启动一次', async () => {
    await render('原始片段')
    const button = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === 'AI修复此项')!
    await act(async () => { button.click(); button.click(); button.click() })
    await vi.waitFor(() => expect(mock.start).toHaveBeenCalledOnce())
  })
  it('启动回执后仍禁用全部修复入口，任务退出后可以再次修复', async () => {
    await render('原始片段')
    mock.start.mockImplementation(async () => {
      useWorkflowStore.setState({ activeRuns: [{ id: 'fix', type: 'chapter_creation', status: 'running', rehydrateParams: { draftPath: 'vela://draft/42', __subflow: 'refine_from_review' } }] as never })
      return {}
    })
    const button = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === 'AI修复此项')!
    await act(async () => { button.click() })
    await vi.waitFor(() => expect(mock.start).toHaveBeenCalledOnce())
    const buttons = [...container.querySelectorAll('button')].filter(b => ['AI修复此项', 'AI修复选中项（精确局部）', 'AI 一键修稿'].includes(b.textContent?.trim() ?? ''))
    expect(buttons).toHaveLength(3)
    expect(buttons.every(b => b.disabled)).toBe(true)
    await act(async () => buttons.forEach(b => b.click()))
    expect(mock.start).toHaveBeenCalledOnce()
    await act(async () => useWorkflowStore.setState({ activeRuns: [] }))
    expect(button.disabled).toBe(false)
  })
  it.each(['running', 'paused', 'waiting'])('已有%s修复任务时重新打开报告仍不可重复启动', async status => {
    useWorkflowStore.setState({ activeRuns: [{ id: 'fix', type: 'chapter_creation', status, rehydrateParams: { draftPath: 'vela://draft/42', __subflow: 'refine_from_review' } }] as never })
    await render('原始片段')
    const button = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === 'AI修复此项')!
    expect(button.disabled).toBe(true)
    await act(async () => button.click())
    expect(mock.start).not.toHaveBeenCalled()
  })
  it('其他章节的修复不阻塞当前章节', async () => {
    useWorkflowStore.setState({ activeRuns: [{ id: 'fix', type: 'chapter_creation', status: 'running', rehydrateParams: { draftPath: 'vela://draft/99', __subflow: 'refine_from_review' } }] as never })
    await render('原始片段')
    await click('AI修复此项')
    expect(mock.start).toHaveBeenCalledOnce()
  })
  it('异步准备期间出现同章节任务时不再提交新任务', async () => {
    mock.invoke.mockImplementation(async () => {
      useWorkflowStore.setState({ activeRuns: [{ id: 'fix', type: 'chapter_creation', status: 'running', rehydrateParams: { draftPath: 'vela://draft/42', __subflow: 'refine_from_review' } }] as never })
      return { content: draft }
    })
    await render('原始片段')
    const button = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === 'AI修复此项')!
    await act(async () => { button.click(); await vi.dynamicImportSettled() })
    expect(mock.start).not.toHaveBeenCalled()
  })
  it('正文过期或有未保存改动时仍拒绝修稿', async () => {
    await render('原始片段', { baseContentHash: '旧指纹' })
    await click('AI修复此项')
    expect(mock.start).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('正文已变化')
    await render('原始片段')
    useEditorStore.setState({ tabs: [{ id: 'draft', name: '正文', type: 'chapter', filePath: 'vela://draft/42', dirty: true }] })
    await click('AI修复此项')
    expect(mock.start).not.toHaveBeenCalled()
    expect(mock.confirm).not.toHaveBeenCalled()
  })
})
