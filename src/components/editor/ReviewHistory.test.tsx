// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ReviewHistory from './ReviewHistory'
import { useProjectStore } from '../../stores/project-store'
import { useEditorStore } from '../../stores/editor-store'
import { globalEventBus } from '../../shared/event-bus'

const mock = vi.hoisted(() => ({ invoke: vi.fn(), confirm: vi.fn(), error: vi.fn() }))
vi.mock('../../services/ipc-client', () => ({ ipc: { invoke: mock.invoke } }))
vi.mock('../ui/Confirm', () => ({ confirm: mock.confirm }))
vi.mock('../ui/Toast', () => ({ toast: { success: vi.fn(), error: mock.error } }))
let root: Root
let container: HTMLDivElement
let entries: Array<{ id: number; baseDraftId: number; reviewIndex: number; contentId: number; createdAt: number }>
const count = vi.fn()
const close = vi.fn()
const render = async () => { await act(async () => root.render(<ReviewHistory open onOpenChange={close} draftId={42} version={1} chapterNumber={1} filePath="vela://draft/42" onCountChange={count} />)) }
const click = async (action: string, index: number) => {
  await act(async () => { document.querySelector<HTMLButtonElement>(`button[aria-label="${action} 正文 v1 · 审稿 #${index}"]`)!.click() })
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  entries = [1, 2, 3].map(n => ({ id: n, baseDraftId: 42, reviewIndex: n, contentId: n, createdAt: 1700000000000 + n }))
  mock.confirm.mockResolvedValue(true)
  mock.invoke.mockImplementation(async (channel: string, id: number) => {
    if (channel === 'db:review-list') return entries
    if (channel === 'db:review-get-full') return { ...entries.find(r => r.id === id), content: `报告${id}` }
    if (channel === 'db:review-delete') { entries = entries.filter(r => r.id !== id); return { success: true } }
  })
  useProjectStore.setState({ currentProject: { path: '/mock/project' } as never })
  useEditorStore.setState({ tabs: [], activeTabId: null })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

describe('审稿历史选择和删除', () => {
  it('最新优先列出全部报告，选择旧报告按ID打开并显示正文版本和审稿序号', async () => {
    await render()
    const buttons = [...document.querySelectorAll('button')].filter(b => b.textContent === '查看报告')
    expect(buttons.map(b => b.getAttribute('aria-label'))).toEqual([3, 2, 1].map(n => `查看报告 正文 v1 · 审稿 #${n}`))
    expect(count).toHaveBeenLastCalledWith(3)
    await click('查看报告', 1)
    expect(mock.invoke).toHaveBeenCalledWith('db:review-get-full', 1)
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ name: '正文 v1 · 审稿 #1', content: '报告1', reportPath: 'vela://review/1' })
    expect(close).toHaveBeenCalledWith(false)
  })
  it('取消或删除失败保留报告和页签', async () => {
    await render()
    mock.confirm.mockResolvedValueOnce(false)
    await click('删除报告', 3)
    expect(mock.invoke.mock.calls.some(c => c[0] === 'db:review-delete')).toBe(false)
    mock.invoke.mockImplementation(async (channel: string) => channel === 'db:review-delete' ? { success: false, error: '失败' } : entries)
    await click('删除报告', 3)
    expect(mock.error).toHaveBeenCalled()
    expect(document.querySelector('button[aria-label="查看报告 正文 v1 · 审稿 #3"]')).toBeTruthy()
    expect(count).toHaveBeenLastCalledWith(3)
  })
  it('删除当前打开报告关闭对应页签，数量及时更新，最后一份删除后显示空态', async () => {
    useEditorStore.setState({ tabs: [{ id: 'review', name: '报告', type: 'review-report', reportPath: 'vela://review/3' }], activeTabId: 'review' })
    await render()
    await click('删除报告', 3)
    expect(useEditorStore.getState().tabs).toEqual([])
    expect(count).toHaveBeenLastCalledWith(2)
    await click('删除报告', 2)
    await click('删除报告', 1)
    expect(count).toHaveBeenLastCalledWith(0)
    expect(document.body.textContent).toContain('当前正文版本暂无审稿报告')
  })
  it('审稿创建事件触发列表与数量更新', async () => {
    await render()
    entries = [...entries, { id: 4, baseDraftId: 42, reviewIndex: 4, contentId: 4, createdAt: 1700000000004 }]
    await act(async () => globalEventBus.emit('REFRESH_RESOURCE', { resources: ['reviews'] }))
    expect(count).toHaveBeenLastCalledWith(4)
    expect(document.querySelector('button[aria-label="查看报告 正文 v1 · 审稿 #4"]')).toBeTruthy()
  })
  it('确认期间切换项目不向新项目发送删除请求', async () => {
    let resolve!: (ok: boolean) => void
    mock.confirm.mockReturnValue(new Promise<boolean>(r => { resolve = r }))
    await render()
    await click('删除报告', 3)
    await act(async () => useProjectStore.setState({ currentProject: { path: '/other' } as never }))
    await act(async () => resolve(true))
    expect(mock.invoke.mock.calls.some(c => c[0] === 'db:review-delete')).toBe(false)
  })
})
