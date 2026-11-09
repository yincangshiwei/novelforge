import { beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { registerProjectController } from './project-controller'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  currentPath: '/projects/original-folder' as string | null,
  core: { projectName: '数据库名称' } as Record<string, unknown>,
  update: vi.fn(),
  writeJson: vi.fn(),
  prepare: vi.fn(),
  close: vi.fn(),
  readonlyOpen: vi.fn(),
  cancelled: false,
}))

vi.mock('../services/agent-operation-journal', () => ({
  isOperationRollback: (error: unknown) => error instanceof Error && 'notCommitted' in error && error.notCommitted === true,
  withOperationCommit: <T>(work: () => T): T => {
    if (h.cancelled) throw Object.assign(new Error('Operation cancelled'), { name: 'AbortError', notCommitted: true })
    const before = { ...h.core }
    try {
      const result = work()
      if (result && (result as { success?: boolean }).success === false) throw Object.assign(new Error('业务操作未提交'), { notCommitted: true })
      return result
    } catch (error) {
      h.core = before
      throw error
    }
  },
  checkOperationCancellation: () => {
    if (h.cancelled) throw Object.assign(new Error('Operation cancelled'), { name: 'AbortError' })
  },
}))

vi.mock('electron', () => ({ dialog: {}, BrowserWindow: {} }))
vi.mock('../security/ipc-guard', () => ({
  guardedHandle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => h.handlers.set(channel, handler),
}))
vi.mock('node:fs', () => ({ default: { existsSync: vi.fn(() => true) } }))
vi.mock('better-sqlite3', () => ({
  default: vi.fn(function (dbPath: string, options: unknown) {
    h.readonlyOpen(dbPath, options)
    return { prepare: h.prepare, pragma: vi.fn(), close: h.close }
  }),
}))
vi.mock('../database', () => ({
  getCurrentProjectPath: () => h.currentPath,
  getProjectDb: () => ({ prepare: h.prepare }),
  initProjectDatabase: vi.fn(),
}))
vi.mock('../repositories/project-core-repository', () => ({
  ProjectCoreRepository: { get: () => h.core, update: h.update },
}))
vi.mock('../utils/config-utils', () => ({
  readJsonFile: () => [],
  writeJsonFile: h.writeJson,
  RECENT_PROJECTS_PATH: '/mock/recent.json',
  getProjectVelaDir: (projectPath: string) => `${projectPath}/.vela`,
}))
vi.mock('../utils/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))
vi.mock('./fs-controller', () => ({ grantDirectory: vi.fn(), assertPathAllowedForIpc: vi.fn() }))

function call(channel: string, ...args: unknown[]) {
  return Promise.resolve(h.handlers.get(channel)!(null, ...args))
}

beforeEach(() => {
  vi.clearAllMocks()
  h.cancelled = false
  h.currentPath = '/projects/original-folder'
  h.core = { projectName: '数据库名称' }
  h.update.mockImplementation((data: { projectName?: string }) => {
    if (data.projectName !== undefined) h.core.projectName = data.projectName
  })
  h.prepare.mockImplementation((sql: string) => ({
    get: () => sql.includes('project_name')
      ? { project_name: h.core.projectName, total_chapters: 100 }
      : { cnt: 0 },
    all: () => [],
  }))
  h.handlers.clear()
  registerProjectController()
})

describe('project:update-config 回读核验', () => {
  it('已取消的配置更新不触及数据库', async () => {
    h.cancelled = true
    await expect(call('project:update-config', 'main', { path: h.currentPath, novelConfig: { globalGuidance: '要求' } })).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.update).not.toHaveBeenCalled()
  })
  it('配置提交后取消仍返回成功', async () => {
    h.update.mockImplementation(data => {
      Object.assign(h.core, data, { updatedAt: 123 })
      h.cancelled = true
    })
    expect(await call('project:update-config', 'main', { path: h.currentPath, novelConfig: { globalGuidance: '要求' } })).toMatchObject({ success: true, revision: 123 })
  })
  it('项目路径不匹配或缺失时不写库', async () => {
    for (const data of [{ novelConfig: { globalGuidance: '要求' } }, { path: '/projects/other', novelConfig: { globalGuidance: '要求' } }]) {
      expect(await call('project:update-config', 'main', data)).toMatchObject({ success: false })
    }
    expect(h.update).not.toHaveBeenCalled()
  })
  it('保存后返回实际字段值和项目路径', async () => {
    h.update.mockImplementation(data => Object.assign(h.core, data, { updatedAt: 123 }))
    expect(await call('project:update-config', 'main', { path: h.currentPath, novelConfig: { globalGuidance: '要求', narrativePOV: 'third_limited' } })).toEqual({
      success: true, projectPath: h.currentPath, revision: 123,
      persistedConfig: { globalGuidance: '要求', narrativePOV: 'third_limited' },
    })
  })
  it('回读与请求不一致不能成功', async () => {
    h.update.mockImplementation(() => undefined)
    expect(await call('project:update-config', 'main', { path: h.currentPath, novelConfig: { globalGuidance: '要求' } })).toMatchObject({ success: false })
  })
  it('空更新不写库', async () => {
    expect(await call('project:update-config', 'main', { path: h.currentPath, novelConfig: {} })).toMatchObject({ success: false })
    expect(h.update).not.toHaveBeenCalled()
  })
})

describe('project-controller 项目改名', () => {
  it.each([null, '/projects/other'])('当前路径为 %s 时拒绝向错误库保存', async (currentPath) => {
    h.currentPath = currentPath
    expect(await call('project:save', 'main', { path: '/projects/original-folder', name: '新名称' })).toMatchObject({ success: false })
    expect(h.update).not.toHaveBeenCalled()
    expect(h.writeJson).not.toHaveBeenCalled()
  })

  it('缺少 path 或 trim 后空名时不写库和 recent', async () => {
    expect(await call('project:save', 'main', { name: '新名称' })).toMatchObject({ success: false })
    expect(await call('project:save', 'main', { path: h.currentPath, name: ' \n ' })).toMatchObject({ success: false })
    expect(h.update).not.toHaveBeenCalled()
    expect(h.writeJson).not.toHaveBeenCalled()
  })

  it('规范化路径后保存 trim 名称，recent 使用数据库名称', async () => {
    expect(await call('project:save', 'main', { path: `${h.currentPath}/.`, name: ' 新名称 ' })).toEqual({ success: true })
    expect(h.update).toHaveBeenCalledWith({ projectName: '新名称' })
    expect(h.writeJson).toHaveBeenCalledWith('/mock/recent.json', [{ name: '新名称', path: h.currentPath, updatedAt: expect.any(Number) }])
  })

  it('不提供 name 的其他保存保留 recent 中的数据库名称', async () => {
    expect(await call('project:save', 'main', { path: h.currentPath, characterStates: '状态' })).toEqual({ success: true })
    expect(h.writeJson).toHaveBeenCalledWith('/mock/recent.json', [{ name: '数据库名称', path: h.currentPath, updatedAt: expect.any(Number) }])
  })

  it('数据库写入失败返回失败且不更新 recent', async () => {
    h.update.mockImplementationOnce(() => { throw new Error('写入失败') })
    expect(await call('project:save', 'main', { path: h.currentPath, name: '新名称' })).toMatchObject({ success: false })
    expect(h.writeJson).not.toHaveBeenCalled()
  })

  it.each(['当前项目', '历史项目'])('%s 的摘要名称取数据库而非文件夹名', async (source) => {
    const projectPath = h.currentPath!
    if (source === '历史项目') h.currentPath = '/projects/other'
    expect(await call('project:get-summary', projectPath)).toMatchObject({ name: '数据库名称', path: projectPath, totalChapters: 100 })
    if (source === '历史项目') {
      expect(h.readonlyOpen).toHaveBeenCalledWith(path.join(projectPath, '.vela', 'vela.db'), { readonly: true })
      expect(h.close).toHaveBeenCalledOnce()
    } else expect(h.readonlyOpen).not.toHaveBeenCalled()
  })
})
