import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { registerFSController } from './fs-controller'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  files: new Map<string, string>(),
  controller: new AbortController(),
}))
vi.mock('../services/agent-operation-journal', () => ({
  currentOperationSignal: () => h.controller.signal,
  checkOperationCancellation: () => {
    if (h.controller.signal.aborted) throw Object.assign(new Error('Operation cancelled'), { name: 'AbortError' })
  },
}))
vi.mock('../security/ipc-guard', () => ({ guardedHandle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => h.handlers.set(channel, handler) }))
vi.mock('../utils/config-utils', () => ({ VELA_HOME: '/mock/novelforge' }))
vi.mock('../database', () => ({ getCurrentProjectPath: () => null }))
vi.mock('../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('node:fs/promises', () => ({ default: {
  mkdir: vi.fn(async () => {}),
  writeFile: vi.fn(async (file: string, text: string) => { h.files.set(file, text) }),
  rename: vi.fn(async (from: string, to: string) => { h.files.set(to, h.files.get(from)!); h.files.delete(from) }),
  unlink: vi.fn(async (file: string) => { h.files.delete(file) }),
  readFile: vi.fn(async (file: string) => h.files.get(file)),
  readdir: vi.fn(async () => []),
} }))
const call = (channel: string, ...args: unknown[]) => Promise.resolve(h.handlers.get(channel)!(null, ...args))
beforeEach(() => {
  vi.clearAllMocks(); h.controller = new AbortController(); h.files.clear(); h.handlers.clear(); registerFSController()
})

describe('主进程归档可靠性', () => {
  it('临时写完成后取消保留旧归档并清理临时文件', async () => {
    await call('fs:agent-archive-write', 'a', 'old')
    const original = vi.mocked(fs.writeFile).getMockImplementation()!
    vi.mocked(fs.writeFile).mockImplementationOnce(async (...args) => {
      await original(...args)
      h.controller.abort()
    })
    await expect(call('fs:agent-archive-write', 'a', 'new')).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.files.get(path.join('/mock/novelforge', 'agent-archive', 'a.json'))).toBe('old')
    expect([...h.files.keys()].some(name => name.endsWith('.tmp'))).toBe(false)
  })
  it('提交完成后取消不否认成功', async () => {
    const original = vi.mocked(fs.rename).getMockImplementation()!
    vi.mocked(fs.rename).mockImplementationOnce(async (...args) => {
      await original(...args)
      h.controller.abort()
    })
    expect(await call('fs:agent-archive-write', 'a', 'committed')).toEqual({ success: true })
    expect(h.files.get(path.join('/mock/novelforge', 'agent-archive', 'a.json'))).toBe('committed')
  })
  it('同毫秒保存使用唯一临时名，串行结果为最新快照', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1)
    try {
      await Promise.all([call('fs:agent-archive-write', 'a', 'old'), call('fs:agent-archive-write', 'a', 'latest')])
      const temps = vi.mocked(fs.writeFile).mock.calls.map(c => String(c[0]))
      expect(new Set(temps).size).toBe(2)
      expect(temps.every(name => name.endsWith('.tmp'))).toBe(true)
      expect(await call('fs:agent-archive-read', 'a')).toBe('latest')
      expect([...h.files.keys()].some(name => name.endsWith('.tmp'))).toBe(false)
    } finally { clock.mockRestore() }
  })
  it('rename失败返回false，保留旧归档并清理临时文件', async () => {
    await call('fs:agent-archive-write', 'a', 'old')
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error('rename failed'))
    expect(await call('fs:agent-archive-write', 'a', 'new')).toMatchObject({ success: false })
    expect(await call('fs:agent-archive-read', 'a')).toBe('old')
    expect([...h.files.keys()].some(name => name.endsWith('.tmp'))).toBe(false)
  })
  it('挂起写入与删除互斥，完成后不会复活归档', async () => {
    let release!: () => void
    const writing = new Promise<void>(r => { release = r })
    const original = vi.mocked(fs.writeFile).getMockImplementation()!
    vi.mocked(fs.writeFile).mockImplementationOnce(async (...args) => { await writing; return original(...args) })
    const save = call('fs:agent-archive-write', 'a', 'content')
    const erase = call('fs:agent-archive-delete', 'a')
    await Promise.resolve(); await Promise.resolve()
    expect(fs.unlink).not.toHaveBeenCalled()
    release(); await Promise.all([save, erase])
    expect(h.files.size).toBe(0)
  })
  it('非法ID拒绝而非清洗到其他归档，列表排除分卷', async () => {
    expect(await call('fs:agent-archive-write', '../a', 'bad')).toMatchObject({ success: false })
    expect(await call('fs:agent-archive-delete', '../a')).toMatchObject({ success: false })
    expect(fs.writeFile).not.toHaveBeenCalled()
    vi.mocked(fs.readdir).mockResolvedValueOnce([
      { name: 'a.json', isFile: () => true },
      { name: 'a.originals.json', isFile: () => true },
    ] as never)
    vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify({ title: 'title', updatedAt: 1 }))
    expect(await call('fs:agent-archive-list')).toEqual([{ id: 'a', title: 'title', updatedAt: 1 }])
  })
})
