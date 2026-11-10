// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDraftStore } from './draft-store'

const mock = vi.hoisted(() => ({ invoke: vi.fn(), audit: vi.fn(), open: vi.fn() }))
vi.mock('../services/ipc-client', () => ({ ipc: { invoke: mock.invoke } }))
vi.mock('../services/audit/refinement-audit', () => ({ auditRefinement: mock.audit }))
vi.mock('../services/draft-index', () => ({ markRevisionMerged: vi.fn() }))
vi.mock('./project-store', () => ({ useProjectStore: { getState: () => ({ currentProject: { id: 'p1' }, refreshFileTree: vi.fn() }) } }))
vi.mock('./editor-store', () => ({ useEditorStore: { getState: () => ({ openFile: mock.open, tabs: [] }) } }))

beforeEach(() => {
  vi.clearAllMocks()
  mock.invoke.mockImplementation(async (channel: string) => channel === 'db:review-next-index' ? 1
    : channel === 'db:draft-get-meta' ? { version: 3 } : { success: true })
  mock.audit.mockResolvedValue({ checked: true, items: [], summary: '复查完成' })
})

describe('合并正文独立复查', () => {
  it('复查实际合并正文而非候选，并绑定写入的底稿', async () => {
    const result = await useDraftStore.getState().applyMergedRevision('', undefined, 'vela://draft/7', '8', '用户部分接受后的正文')
    expect(result.success).toBe(true)
    expect(mock.audit).toHaveBeenCalledWith('用户部分接受后的正文', 7, 3)
    const saved = mock.invoke.mock.calls.find(call => call[0] === 'db:review-create')
    expect(JSON.parse(saved![1].content)).toMatchObject({ scope: 'merged_draft', revisionId: '8' })
    expect(mock.open).toHaveBeenCalled()
  })
  it('复查异常不撤销已合并的正文', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mock.audit.mockRejectedValue(new Error('审计异常'))
    expect((await useDraftStore.getState().applyMergedRevision('', undefined, 'vela://draft/7', '8', '正文')).success).toBe(true)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
