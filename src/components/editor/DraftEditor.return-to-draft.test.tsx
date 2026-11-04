// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import EditorArea from '../panels/EditorArea'
import { useEditorStore } from '../../stores/editor-store'
import { useProjectStore } from '../../stores/project-store'
import { useLayoutStore } from '../../stores/layout-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { useDraftStore } from '../../stores/draft-store'
import { globalEventBus } from '../../shared/event-bus'
import { initProjectService, disposeProjectService } from '../../services/project-service'

const mock = vi.hoisted(() => ({
  invoke: vi.fn(), confirm: vi.fn(),
  autoSave: undefined as undefined | ((text: string) => Promise<void>),
  status: 'finalized',
}))
vi.mock('../../services/ipc-client', () => ({ ipc: { invoke: mock.invoke } }))
vi.mock('../ui/Confirm', () => ({ confirm: mock.confirm }))
vi.mock('../ui/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }))
vi.mock('../ui/PostProcessStatusPanel', () => ({ PostProcessStatusPanel: () => <div data-post-process /> }))
vi.mock('../../hooks/useAutoSave', () => ({ useAutoSave: (_path: string, _ref: unknown, save: (text: string) => Promise<void>) => { mock.autoSave = save } }))
vi.mock('../../services/draft-index', async importOriginal => ({
  ...await importOriginal<typeof import('../../services/draft-index')>(),
  getPendingRevisions: vi.fn(async () => []), getReviewsForVersion: vi.fn(async () => []),
}))
vi.mock('./CodeMirrorEditor', () => ({ default: (props: {
  content: string; editable?: boolean; onChange: (text: string) => void; onSave: (text: string) => void
}) => <textarea aria-label="测试正文" value={props.content} readOnly={!props.editable}
  onChange={event => props.onChange(event.target.value)}
  onKeyDown={event => { if (event.key === 's' && event.ctrlKey) props.onSave(props.content) }} /> }))

let root: Root
let container: HTMLDivElement
const meta = () => ({ id: 42, chapterNumber: 3, version: 2, status: mock.status, source: 'write', createdAt: 1 })
const button = (text: string) => [...container.querySelectorAll('button')].find(b => b.textContent === text)
const body = () => container.querySelector('textarea')!
async function click(text = '退回草稿') {
  await act(async () => { button(text)!.click() })
}
async function render(path: string, dirty = false) {
  useEditorStore.setState({
    tabs: [
      { id: 'custom-tab-id', name: '第 3 章', type: 'chapter', filePath: path, content: '当前正文', dirty },
      { id: 'other-dirty', name: '同正文草稿', type: 'chapter', filePath: 'vela://draft/42', content: '另一页签未保存正文', dirty: true },
    ], activeTabId: 'custom-tab-id',
  })
  await act(async () => { root.render(<EditorArea onNewProject={() => {}} />) })
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Element.prototype.scrollIntoView = vi.fn()
  mock.status = 'finalized'
  mock.autoSave = undefined
  mock.confirm.mockReset().mockResolvedValue(true)
  mock.invoke.mockReset().mockImplementation(async (channel: string) => {
    if (channel === 'db:draft-get-meta') return meta()
    if (channel === 'db:draft-update-status') { mock.status = 'draft'; return { success: true } }
    if (channel === 'db:draft-update-content') return { success: true }
    if (channel === 'db:blueprint-get-all') return [{ chapterNumber: 3, title: '开端' }]
    if (channel === 'db:draft-get-all-chapter-numbers') return [3]
    if (channel === 'db:draft-list') return [meta()]
    return []
  })
  useProjectStore.setState({ currentProject: { path: '/mock/proj' } as never })
  useLayoutStore.setState({ sidebarView: 'project' })
  useWorkflowStore.setState({ activeRuns: [] })
  useDraftStore.setState({ draftsByChapter: {} })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  disposeProjectService()
  vi.restoreAllMocks()
})

describe('数据库正式稿退回草稿 UI', () => {
  it.each(['vela://draft/42', 'vela://manuscript/42'])('%s 使用状态编辑器；只读期间禁止快捷键/自动保存', async path => {
    await render(path)
    expect(button('退回草稿')).toBeTruthy()
    expect(body().readOnly).toBe(true)
    await act(async () => {
      body().dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))
      await mock.autoSave!('不应保存')
    })
    expect(mock.invoke.mock.calls.some(call => call[0] === 'db:draft-update-content')).toBe(false)
  })

  it('确认取消不变更状态；提示明确说明非完整撤销和保留范围', async () => {
    mock.confirm.mockResolvedValue(false)
    await render('vela://manuscript/42')
    await click()
    expect(mock.confirm.mock.calls[0][0]).toMatch(/正文和版本/)
    expect(mock.confirm.mock.calls[0][0]).toMatch(/章节文件、知识库/)
    expect(mock.confirm.mock.calls[0][0]).toMatch(/不是完整撤销/)
    expect(mock.invoke.mock.calls.some(call => call[0] === 'db:draft-update-status')).toBe(false)
    expect(body().readOnly).toBe(true)
  })

  it('写失败保持只读、页签正文及 dirty 原样', async () => {
    await render('vela://manuscript/42', true)
    const tabs = useEditorStore.getState().tabs
    mock.invoke.mockImplementation(async (channel: string) => channel === 'db:draft-get-meta' ? meta() : { success: false, error: '失败' })
    await click()
    expect(body().readOnly).toBe(true)
    expect(useEditorStore.getState().tabs).toBe(tabs)
    expect(button('退回草稿')).toBeTruthy()
  })

  it('成功后原页签可编辑，保留脏页签并通过 manuscript URI 保存正确 id', async () => {
    initProjectService()
    await render('vela://manuscript/42', true)
    const otherTab = useEditorStore.getState().tabs[1]
    await click()
    expect(body().readOnly).toBe(false)
    expect(container.querySelector('[data-post-process]')).toBeNull()
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ id: 'custom-tab-id', filePath: 'vela://manuscript/42', content: '当前正文', dirty: true })
    expect(useEditorStore.getState().tabs[1]).toBe(otherTab)
    expect(mock.invoke).toHaveBeenCalledWith('db:draft-list', 3)
    expect(useDraftStore.getState().draftsByChapter[3][0].status).toBe('draft')
    // React 受控 textarea 的原生输入事件，验证 filePath != tab id 时不会丢改动。
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(body(), '修改后的正文')
      body().dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(useEditorStore.getState().tabs[0].content).toBe('修改后的正文')
    await act(async () => { body().dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })) })
    expect(mock.invoke).toHaveBeenCalledWith('db:draft-update-content', 42, '修改后的正文', expect.any(Number))
    expect(useEditorStore.getState().tabs[0].dirty).toBe(false)
    expect(useEditorStore.getState().tabs[1]).toBe(otherTab)
    expect(mock.invoke.mock.calls.some(call => String(call[0]).startsWith('fs:') || String(call[0]).startsWith('kb:'))).toBe(false)
  })

  it('退回后保存失败保留 dirty 和正文', async () => {
    await render('vela://manuscript/42', true)
    await click()
    mock.invoke.mockImplementation(async () => ({ success: false, error: '写入失败' }))
    await act(async () => { body().dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })) })
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: '当前正文', dirty: true })
  })

  it('提交等待期间禁用入口并阻止重复提交', async () => {
    let resolve!: (value: boolean) => void
    mock.confirm.mockReturnValue(new Promise<boolean>(done => { resolve = done }))
    await render('vela://manuscript/42')
    await click()
    expect(button('退回中…')?.disabled).toBe(true)
    await click('退回中…')
    expect(mock.confirm).toHaveBeenCalledTimes(1)
    await act(async () => { resolve(true) })
    expect(mock.invoke.mock.calls.filter(call => call[0] === 'db:draft-update-status')).toHaveLength(1)
  })

  it('任意工作流活跃时禁用退回，确认期间启动工作流也拒绝写入', async () => {
    await render('vela://manuscript/42')
    await act(async () => { useWorkflowStore.setState({ activeRuns: [{ type: 'architecture_generation', title: '架构', status: 'running' } as never] }) })
    expect(button('退回草稿')?.disabled).toBe(true)
    await act(async () => { useWorkflowStore.setState({ activeRuns: [] }) })
    mock.confirm.mockImplementation(async () => {
      useWorkflowStore.setState({ activeRuns: [{ type: 'chapter_creation', title: '第 3 章', status: 'running' } as never] })
      return true
    })
    await click()
    expect(mock.invoke.mock.calls.some(call => call[0] === 'db:draft-update-status')).toBe(false)
    expect(body().readOnly).toBe(true)
  })

  it('归档无退回入口', async () => {
    mock.status = 'archived'
    await render('vela://manuscript/42')
    expect(button('退回草稿')).toBeUndefined()
    expect(body().readOnly).toBe(true)
  })

  it('共享缓存更新使已打开正式稿恢复编辑', async () => {
    await render('vela://manuscript/42')
    expect(body().readOnly).toBe(true)
    await act(async () => {
      useDraftStore.setState({ draftsByChapter: { 3: [{ ...meta(), status: 'draft' } as never] } })
      globalEventBus.emit('REFRESH_RESOURCE', { resources: ['drafts'] })
    })
    expect(body().readOnly).toBe(false)
  })
})
