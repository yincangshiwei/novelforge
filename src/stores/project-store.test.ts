// @vitest-environment jsdom
/**
 * project-store 快照机制（线③ 产出审查层：前置快照 + 撤销出口）
 *
 * 契约：snapshotNovelConfig 深拷贝当前配置；restoreNovelConfigSnapshot 恢复快照
 * 并清空快照；无快照/无项目时 no-op 返回 false。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useProjectStore } from './project-store'
import { ipc } from '../services/ipc-client'
import type { ProjectData } from '../shared/ipc-channels'

vi.mock('../services/ipc-client', () => ({
  ipc: { invoke: vi.fn().mockResolvedValue(true) },
}))

const BASE: ProjectData = {
  id: 'p1',
  name: '测试小说',
  path: '/test',
  novelConfig: {
    genre: '玄幻',
    subGenre: '',
    targetAudience: '',
    totalChapters: 100,
    wordsPerChapter: 3000,
    plotStructure: 'three_act',
    narrativePOV: 'third_limited',
    coreOutline: '旧大纲',
    worldSetting: '',
    goldenFinger: '',
    protagonistProfile: '',
    globalGuidance: '',
  },
  characterStates: '',
  createdAt: 0,
  updatedAt: 0,
}

beforeEach(() => {
  vi.mocked(ipc.invoke).mockReset().mockResolvedValue({ success: true })
  useProjectStore.setState({
    recentProjects: [{ name: BASE.name, path: BASE.path, updatedAt: 0 }],
    currentProject: structuredClone(BASE),
    configSnapshot: null,
  })
})

afterEach(() => {
  useProjectStore.setState({ currentProject: null, configSnapshot: null, recentProjects: [] })
})

describe('project-store 执行中项目隔离', () => {
  it('Agent 执行中不能切换、关闭或删除当前项目', async () => {
    const { useAgentStore } = await import('./agent-store')
    useAgentStore.setState({ generating: true })
    try {
      expect(await useProjectStore.getState().openProject('/other')).toBe(false)
      expect(await useProjectStore.getState().closeProject()).toBe(false)
      expect(await useProjectStore.getState().deleteProjectFolder(BASE.path)).toBe(false)
      expect(vi.mocked(ipc.invoke).mock.calls.some(call => call[0] === 'project:open' || call[0] === 'project:delete-folder')).toBe(false)
      expect(useProjectStore.getState().currentProject?.path).toBe(BASE.path)
    } finally {
      useAgentStore.setState({ generating: false })
    }
  })

  it('新建项目的 loading 不阻止后续打开；并发打开被拒绝', async () => {
    useProjectStore.setState({ loading: true })
    let resolve!: (value: { success: boolean }) => void
    vi.mocked(ipc.invoke).mockImplementation(async (...args: unknown[]) => {
      if (args[0] === 'project:open') return new Promise<{ success: boolean }>(done => { resolve = done })
      return { success: true }
    })
    const first = useProjectStore.getState().openProject('/new')
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    expect(await useProjectStore.getState().openProject('/other')).toBe(false)
    resolve({ success: false })
    expect(await first).toBe(false)
    expect(useProjectStore.getState().loading).toBe(false)
  })
})

describe('project-store 项目改名', () => {
  it('无项目、空名称和同名均不调用 IPC', async () => {
    const { renameProject } = useProjectStore.getState()
    expect(await renameProject(' \n ')).toBe(false)
    expect(await renameProject(` ${BASE.name} `)).toBe(true)
    useProjectStore.setState({ currentProject: null })
    expect(await renameProject('新名称')).toBe(false)
    expect(ipc.invoke).not.toHaveBeenCalled()
  })

  it('trim 后只保存名称，成功更新 current、recent 和全局配置', async () => {
    const other = { name: '其他项目', path: '/other', updatedAt: 1 }
    useProjectStore.setState({ recentProjects: [other, { name: BASE.name, path: BASE.path, updatedAt: 0 }] })
    expect(await useProjectStore.getState().renameProject(' 新名称 ')).toBe(true)
    expect(ipc.invoke).toHaveBeenNthCalledWith(1, 'project:save', BASE.id, { path: BASE.path, name: '新名称' })
    const state = useProjectStore.getState()
    expect(state.currentProject).toMatchObject({ name: '新名称', path: BASE.path, novelConfig: BASE.novelConfig })
    expect(state.recentProjects).toEqual([{ name: '新名称', path: BASE.path, updatedAt: expect.any(Number) }, other])
    expect(ipc.invoke).toHaveBeenNthCalledWith(2, 'config:set', { recentProjects: state.recentProjects })
  })

  it.each(['失败响应', '抛出异常'])('%s 时不更新名称或 recent', async (failure) => {
    const before = useProjectStore.getState()
    if (failure === '失败响应') vi.mocked(ipc.invoke).mockResolvedValueOnce({ success: false, error: '失败' })
    else vi.mocked(ipc.invoke).mockRejectedValueOnce(new Error('失败'))
    expect(await before.renameProject('新名称')).toBe(false)
    expect(useProjectStore.getState().currentProject).toBe(before.currentProject)
    expect(useProjectStore.getState().recentProjects).toBe(before.recentProjects)
    expect(ipc.invoke).toHaveBeenCalledTimes(1)
  })

  it('保存超时不更新名称，迟到的成功也不改变内存', async () => {
    vi.useFakeTimers()
    try {
      let resolve!: (result: { success: boolean }) => void
      vi.mocked(ipc.invoke).mockReturnValueOnce(new Promise<{ success: boolean }>(done => { resolve = done }))
      const before = useProjectStore.getState()
      const pending = before.renameProject('新名称')
      await vi.advanceTimersByTimeAsync(15_000)
      expect(await pending).toBe(false)
      resolve({ success: true })
      await Promise.resolve()
      expect(useProjectStore.getState().currentProject).toBe(before.currentProject)
      expect(useProjectStore.getState().recentProjects).toBe(before.recentProjects)
    } finally {
      vi.useRealTimers()
    }
  })

  it('保存等待期间不提前改名，成功后保留最新配置', async () => {
    let resolve!: (result: { success: boolean }) => void
    vi.mocked(ipc.invoke).mockReturnValueOnce(new Promise<{ success: boolean }>(done => { resolve = done }))
    const pending = useProjectStore.getState().renameProject('新名称')
    expect(useProjectStore.getState().currentProject!.name).toBe(BASE.name)
    useProjectStore.getState().updateNovelConfig({ coreOutline: '等待期间编辑' })
    resolve({ success: true })
    expect(await pending).toBe(true)
    expect(useProjectStore.getState().currentProject!.novelConfig.coreOutline).toBe('等待期间编辑')
  })

  it.each(['切换项目', '关闭项目'])('%s 后旧改名成功不覆盖当前项目', async (action) => {
    let resolve!: (result: { success: boolean }) => void
    vi.mocked(ipc.invoke).mockReturnValueOnce(new Promise<{ success: boolean }>(done => { resolve = done }))
    const pending = useProjectStore.getState().renameProject('新名称')
    // 实际打开的项目共用 main ID，因此隔离必须同时检查 path。
    const next = action === '关闭项目' ? null : { ...BASE, path: '/other', name: '其他项目' }
    useProjectStore.setState({ currentProject: next, recentProjects: next ? [{ name: next.name, path: next.path, updatedAt: 1 }] : [] })
    resolve({ success: true })
    expect(await pending).toBe(true)
    expect(useProjectStore.getState().currentProject).toBe(next)
    expect(useProjectStore.getState().recentProjects[0]).toMatchObject({ name: '新名称', path: BASE.path })
    if (next) expect(useProjectStore.getState().recentProjects[1]).toMatchObject({ name: next.name, path: next.path })
  })

  it('全局配置同步失败不回滚已经保存的名称', async () => {
    vi.mocked(ipc.invoke).mockResolvedValueOnce({ success: true }).mockRejectedValueOnce(new Error('配置失败'))
    expect(await useProjectStore.getState().renameProject('新名称')).toBe(true)
    expect(useProjectStore.getState().currentProject!.name).toBe('新名称')
  })
})

describe('project-store 快照机制（线③）', () => {
  it('snapshot 深拷贝当前配置；update 后 restore 恢复原值', () => {
    const { snapshotNovelConfig, updateNovelConfig, restoreNovelConfigSnapshot } = useProjectStore.getState()

    snapshotNovelConfig()
    updateNovelConfig({ coreOutline: 'AI 生成的新大纲', genre: '仙侠' })

    // 应用后：配置已变，快照仍在
    expect(useProjectStore.getState().currentProject!.novelConfig.coreOutline).toBe('AI 生成的新大纲')

    const ok = restoreNovelConfigSnapshot()
    expect(ok).toBe(true)
    // 恢复：回到快照（旧大纲 + 旧题材），快照清空
    const cfg = useProjectStore.getState().currentProject!.novelConfig
    expect(cfg.coreOutline).toBe('旧大纲')
    expect(cfg.genre).toBe('玄幻')
    expect(useProjectStore.getState().configSnapshot).toBeNull()
  })

  it('快照是深拷贝——update 后快照不被浅合并污染', () => {
    const { snapshotNovelConfig, updateNovelConfig } = useProjectStore.getState()
    snapshotNovelConfig()
    updateNovelConfig({ coreOutline: '新值' })
    // 快照里的 coreOutline 仍是旧值
    expect(useProjectStore.getState().configSnapshot!.coreOutline).toBe('旧大纲')
  })

  it('无快照时 restore 返回 false 且不改动配置', () => {
    const { restoreNovelConfigSnapshot } = useProjectStore.getState()
    expect(restoreNovelConfigSnapshot()).toBe(false)
    expect(useProjectStore.getState().currentProject!.novelConfig.coreOutline).toBe('旧大纲')
  })

  it('无 currentProject 时 snapshot/restore 均 no-op', () => {
    useProjectStore.setState({ currentProject: null })
    const { snapshotNovelConfig, restoreNovelConfigSnapshot } = useProjectStore.getState()
    snapshotNovelConfig()
    expect(useProjectStore.getState().configSnapshot).toBeNull()
    expect(restoreNovelConfigSnapshot()).toBe(false)
  })
})
