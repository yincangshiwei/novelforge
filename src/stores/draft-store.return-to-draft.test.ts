// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDraftStore } from './draft-store'
import { globalEventBus } from '../shared/event-bus'

const mock = vi.hoisted(() => ({
  invoke: vi.fn(),
  project: { path: '/mock/project' } as { path: string } | null,
  runs: [] as unknown[],
}))
vi.mock('../services/ipc-client', () => ({ ipc: { invoke: mock.invoke } }))
vi.mock('./project-store', () => ({ useProjectStore: { getState: () => ({ currentProject: mock.project }) } }))
vi.mock('./workflow-store', () => ({ useWorkflowStore: { getState: () => ({ activeRuns: mock.runs }) } }))
vi.mock('../services/workflows/chapter-workflow', () => ({ getDraftDir: vi.fn() }))

const meta = { id: 42, chapterNumber: 3, version: 2, status: 'finalized', source: 'write', fileName: 'v2', createdAt: 1 }
beforeEach(() => {
  vi.restoreAllMocks()
  mock.invoke.mockReset()
  mock.project = { path: '/mock/project' }
  mock.runs = []
  useDraftStore.setState({ draftsByChapter: { 3: [{ ...meta } as never] } })
  mock.invoke.mockImplementation(async (channel: string) => {
    if (channel === 'db:draft-get-meta') return { ...meta }
    if (channel === 'db:draft-update-status') return { success: true }
    throw new Error(`不应调用 ${channel}`)
  })
})

describe('returnToDraft — 仅状态变更', () => {
  it.each(['vela://draft/42', 'vela://manuscript/42'])('核验并退回 %s，刷新共享列表但不改正文/版本', async path => {
    const emit = vi.spyOn(globalEventBus, 'emit')
    expect(await useDraftStore.getState().returnToDraft(path, 3)).toEqual({ success: true })
    expect(mock.invoke.mock.calls).toEqual([
      ['db:draft-get-meta', 42], ['db:draft-update-status', 42, 'draft'],
    ])
    expect(useDraftStore.getState().draftsByChapter[3][0]).toEqual({ ...meta, status: 'draft' })
    expect(emit).toHaveBeenCalledWith('REFRESH_RESOURCE', { resources: ['drafts'] })
  })

  it.each(['vela://draft/', 'vela://draft/ch3/v2', 'vela://manuscript/42x', 'vela://draft/0', 'vela://draft/9007199254740992', '/draft_v2.md'])('拒绝非法 id %s', async path => {
    expect((await useDraftStore.getState().returnToDraft(path, 3)).success).toBe(false)
    expect(mock.invoke).not.toHaveBeenCalled()
  })

  it.each([null, { ...meta, id: 43 }, { ...meta, chapterNumber: 4 }, ...['draft', 'archived', 'revised'].map(status => ({ ...meta, status }))])('拒绝不存在或不匹配的数据库元数据 %j', async dbMeta => {
    mock.invoke.mockResolvedValue(dbMeta)
    const before = useDraftStore.getState().draftsByChapter
    expect((await useDraftStore.getState().returnToDraft('vela://draft/42', 3)).success).toBe(false)
    expect(mock.invoke).toHaveBeenCalledTimes(1)
    expect(useDraftStore.getState().draftsByChapter).toBe(before)
  })

  it.each(['返回失败', '抛出异常'])('%s 时不更新缓存或发出刷新', async mode => {
    const before = useDraftStore.getState().draftsByChapter
    const emit = vi.spyOn(globalEventBus, 'emit')
    mock.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'db:draft-get-meta') return meta
      if (mode === '抛出异常') throw new Error('写入失败')
      return { success: false, error: '写入失败' }
    })
    expect((await useDraftStore.getState().returnToDraft('vela://manuscript/42', 3)).success).toBe(false)
    expect(useDraftStore.getState().draftsByChapter).toBe(before)
    expect(emit).not.toHaveBeenCalled()
  })

  it.each(['项目切换', '工作流启动'])('元数据读取期间%s，写入前阻止操作', async change => {
    mock.invoke.mockImplementation(async () => {
      if (change === '项目切换') mock.project = { path: '/other/project' }
      else mock.runs = [{ status: 'running' }]
      return meta
    })
    expect((await useDraftStore.getState().returnToDraft('vela://draft/42', 3)).success).toBe(false)
    expect(mock.invoke).toHaveBeenCalledTimes(1)
  })

  it('同一数据库行的 draft/manuscript 双入口并发提交只写一次', async () => {
    let resolve!: (value: typeof meta) => void
    mock.invoke.mockImplementation((channel: string) => {
      if (channel === 'db:draft-get-meta') return new Promise(done => { resolve = done })
      return Promise.resolve({ success: true })
    })
    const first = useDraftStore.getState().returnToDraft('vela://draft/42', 3)
    expect((await useDraftStore.getState().returnToDraft('vela://manuscript/42', 3)).success).toBe(false)
    resolve(meta)
    expect((await first).success).toBe(true)
    expect(mock.invoke.mock.calls.filter(call => call[0] === 'db:draft-update-status')).toHaveLength(1)
  })

  it('无项目时不访问数据库', async () => {
    mock.project = null
    expect((await useDraftStore.getState().returnToDraft('vela://draft/42', 3)).success).toBe(false)
    expect(mock.invoke).not.toHaveBeenCalled()
  })
})
