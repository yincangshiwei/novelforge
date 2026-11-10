// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import { useDraftStore } from './draft-store'
const h = vi.hoisted(() => ({ invoke: vi.fn(), project: { path: '/project' }, tabs: [] as Array<{ id: string; filePath?: string; chapterNumber?: number }>, runs: [] as unknown[] }))
vi.mock('../services/ipc-client', () => ({ ipc: { invoke: h.invoke } }))
vi.mock('./project-store', () => ({ useProjectStore: { getState: () => ({ currentProject: h.project }) } }))
vi.mock('./editor-store', () => ({ useEditorStore: { getState: () => ({ tabs: h.tabs }) } }))
vi.mock('./workflow-store', () => ({ useWorkflowStore: { getState: () => ({ activeRuns: h.runs }) } }))
vi.mock('../services/workflows/chapter-workflow', () => ({ getDraftDir: vi.fn() }))
beforeEach(() => {
  h.invoke.mockReset().mockImplementation(async channel => channel === 'db:draft-get-meta' ? { id: 7, chapterNumber: 1, status: 'archived' } : { success: true })
  h.tabs = []; h.runs = []; h.project = { path: '/project' }
  useDraftStore.setState({ draftsByChapter: { 1: [{ id: 7, filePath: 'vela://draft/7' } as never] } })
})
it('归档版本删除成功刷新列表', async () => {
  expect(await useDraftStore.getState().deleteArchivedDraft('vela://draft/7', 1)).toEqual({ success: true })
  expect(h.invoke).toHaveBeenCalledWith('db:draft-delete', 7, 1)
  expect(useDraftStore.getState().draftsByChapter[1]).toEqual([])
})
it('打开页签或工作流运行时拒绝删除', async () => {
  h.tabs = [{ id: 'vela://draft/7' }]
  expect((await useDraftStore.getState().deleteArchivedDraft('vela://draft/7', 1)).success).toBe(false)
  h.tabs = []; h.runs = [{}]
  expect((await useDraftStore.getState().deleteArchivedDraft('vela://draft/7', 1)).success).toBe(false)
  expect(h.invoke.mock.calls.some(call => call[0] === 'db:draft-delete')).toBe(false)
})
it('失败不移除缓存，切项目后不发删除请求', async () => {
  h.invoke.mockResolvedValueOnce({ id: 7, chapterNumber: 1, status: 'archived' }).mockResolvedValueOnce({ success: false, error: 'disk' })
  expect((await useDraftStore.getState().deleteArchivedDraft('vela://draft/7', 1)).success).toBe(false)
  expect(useDraftStore.getState().draftsByChapter[1]).toHaveLength(1)
  h.invoke.mockImplementationOnce(async () => { h.project = { path: '/other' }; return { id: 7, chapterNumber: 1, status: 'archived' } })
  expect((await useDraftStore.getState().deleteArchivedDraft('vela://draft/7', 1)).success).toBe(false)
})
