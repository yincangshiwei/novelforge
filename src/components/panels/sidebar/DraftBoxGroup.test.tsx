// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { DraftMeta } from '../../../stores/draft-store'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const h = vi.hoisted(() => ({ confirm: vi.fn(), mark: vi.fn(), remove: vi.fn(), read: vi.fn(), open: vi.fn(), error: vi.fn() }))
vi.mock('../../../stores/draft-store', () => ({ useDraftStore: { getState: () => ({ markDraftStatus: h.mark, deleteArchivedDraft: h.remove }) }, readDraftBody: h.read }))
vi.mock('../../../stores/editor-store', () => ({ useEditorStore: { getState: () => ({ openFile: h.open }) } }))
vi.mock('../../ui/Confirm', () => ({ confirm: h.confirm }))
vi.mock('../../ui/Toast', () => ({ toast: { error: h.error } }))
vi.mock('../../../services/ipc-client', () => ({ ipc: { invoke: vi.fn(async () => []) } }))
vi.mock('../../../hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('./SidebarShared', () => ({ showSidebarMenu: vi.fn() }))
vi.mock('./SidebarGroup', () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
import DraftBoxGroup from './DraftBoxGroup'
let cleanup: (() => void) | undefined
afterEach(() => { cleanup?.(); document.body.innerHTML = ''; vi.resetAllMocks() })
async function render(status = 'draft') {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  cleanup = () => act(() => root.unmount())
  const draft = { filePath: 'vela://draft/7', chapterNumber: 1, version: 2, chapterTitle: 'test', status } as DraftMeta
  await act(async () => root.render(<DraftBoxGroup draftsByChapter={{ 1: [draft] }} />))
  await act(async () => (container.querySelector('button') as HTMLButtonElement).click())
  if (status === 'archived') {
    const showArchived = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('draftbox.showArchived'))!
    await act(async () => showArchived.click())
  }
  return container.querySelector('[aria-label^="action.deleteDraft"], [aria-label^="draftbox.permanentDelete"]') as HTMLButtonElement
}
it('版本行提供纯图标删除，确认后归档且不打开正文', async () => {
  h.confirm.mockResolvedValue(true)
  h.mark.mockResolvedValue(undefined)
  const button = await render()
  expect(button.textContent).toBe('')
  expect(button.querySelector('svg')).not.toBeNull()
  await act(async () => button.click())
  expect(h.mark).toHaveBeenCalledWith('vela://draft/7', 1, 'archived')
  expect(h.read).not.toHaveBeenCalled()
  expect(h.open).not.toHaveBeenCalled()
})
it('归档版本提供永久删除图标和单独确认', async () => {
  h.confirm.mockResolvedValue(true)
  h.remove.mockResolvedValue({ success: true })
  const button = await render('archived')
  expect(button.textContent).toBe('')
  expect(button.title).toBe('draftbox.permanentDelete')
  await act(async () => button.click())
  expect(h.confirm.mock.calls[0][0]).toContain('draftbox.permanentDeleteConfirm')
  expect(h.remove).toHaveBeenCalledWith('vela://draft/7', 1)
  expect(h.mark).not.toHaveBeenCalled()
})
it('取消确认不删除', async () => {
  h.confirm.mockResolvedValue(false)
  const button = await render()
  await act(async () => button.click())
  expect(h.mark).not.toHaveBeenCalled()
})
it('已定稿版本删除图标禁用', async () => {
  const button = await render('finalized')
  expect(button.disabled).toBe(true)
  expect(h.confirm).not.toHaveBeenCalled()
})
it('归档失败提示原因并允许再次操作', async () => {
  h.confirm.mockResolvedValue(true)
  h.mark.mockRejectedValue(new Error('数据库写入失败'))
  const button = await render()
  await act(async () => button.click())
  expect(h.error).toHaveBeenCalledWith('数据库写入失败')
  expect(button.disabled).toBe(false)
})
