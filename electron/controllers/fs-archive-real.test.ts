import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { registerFSController } from './fs-controller'

const h = vi.hoisted(() => ({
  home: '',
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}))
vi.mock('../security/ipc-guard', () => ({ guardedHandle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => h.handlers.set(channel, handler) }))
vi.mock('../utils/config-utils', () => ({ get VELA_HOME() { return h.home } }))
vi.mock('../database', () => ({ getCurrentProjectPath: () => null }))
vi.mock('../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const call = (channel: string, ...args: unknown[]) => Promise.resolve(h.handlers.get(channel)!(null, ...args))
const archiveDir = () => path.join(h.home, 'agent-archive')
const assertNoTemps = async () => expect((await fs.readdir(archiveDir())).filter(name => name.endsWith('.tmp'))).toEqual([])

beforeEach(async () => {
  h.home = await fs.mkdtemp(path.join(process.cwd(), '.fs-archive-real-test-'))
  h.handlers.clear()
  registerFSController()
})
afterEach(async () => {
  vi.restoreAllMocks()
  h.handlers.clear()
  await fs.rm(h.home, { recursive: true, force: true })
})

describe('真实文件系统归档可靠性（仅合成目录）', () => {
  it('并发同毫秒保存使用唯一真实临时文件且最新快照胜出', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1)
    const write = vi.spyOn(fs, 'writeFile')
    const snapshots = Array.from({ length: 12 }, (_, updatedAt) => JSON.stringify({ title: 'synthetic', updatedAt }))
    const results = await Promise.all(snapshots.map(content => call('fs:agent-archive-write', 'synthetic', content)))
    expect(results.every(result => (result as { success: boolean }).success)).toBe(true)
    const temps = write.mock.calls.map(args => String(args[0]))
    expect(temps).toHaveLength(snapshots.length)
    expect(new Set(temps).size).toBe(snapshots.length)
    expect(temps.every(file => file.startsWith(archiveDir()) && file.endsWith('.tmp'))).toBe(true)
    expect(await fs.readFile(path.join(archiveDir(), 'synthetic.json'), 'utf8')).toBe(snapshots.at(-1))
    await assertNoTemps()
  })

  it('真实 rename 失败保留旧归档并删除实际临时文件', async () => {
    expect(await call('fs:agent-archive-write', 'synthetic', 'old')).toEqual({ success: true })
    const rename = fs.rename.bind(fs)
    const spy = vi.spyOn(fs, 'rename').mockImplementationOnce((from, to) => rename(from, path.join(String(to), 'missing', 'target.json')))
    expect(await call('fs:agent-archive-write', 'synthetic', 'new')).toMatchObject({ success: false })
    expect(spy).toHaveBeenCalledOnce()
    expect(await call('fs:agent-archive-read', 'synthetic')).toBe('old')
    await assertNoTemps()
  })

  it('挂起真实写入与删除互斥，删除后归档和分卷均不复活', async () => {
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const writing = new Promise<void>(resolve => { entered = resolve })
    const write = fs.writeFile.bind(fs)
    vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (...args) => {
      entered()
      await gate
      return write(...args)
    })
    const save = call('fs:agent-archive-write', 'synthetic', 'pending')
    await writing
    let deleted = false
    const erase = call('fs:agent-archive-delete', 'synthetic').then(result => { deleted = true; return result })
    try {
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(deleted).toBe(false)
    } finally { release() }
    expect(await Promise.all([save, erase])).toEqual([{ success: true }, { success: true }])
    expect(await call('fs:agent-archive-read', 'synthetic')).toBeNull()
    expect(await call('fs:agent-archive-original-write', 'synthetic', 'original')).toEqual({ success: true })
    expect(await call('fs:agent-archive-original-delete', 'synthetic')).toEqual({ success: true })
    expect(await fs.readdir(archiveDir())).toEqual([])
  })

  it('重新载入控制器可读取真实归档与原文，列表忽略分卷及临时文件', async () => {
    const content = JSON.stringify({ title: 'synthetic restart', updatedAt: 123, messages: [] })
    await call('fs:agent-archive-write', 'synthetic', content)
    await call('fs:agent-archive-original-write', 'synthetic', 'synthetic originals')
    await fs.writeFile(path.join(archiveDir(), 'interrupted.json.tmp'), 'incomplete')
    h.handlers.clear()
    vi.resetModules()
    const restarted = await import('./fs-controller')
    restarted.registerFSController()
    expect(await call('fs:agent-archive-read', 'synthetic')).toBe(content)
    expect(await call('fs:agent-archive-original-read', 'synthetic')).toEqual({ success: true, content: 'synthetic originals' })
    expect(await call('fs:agent-archive-list')).toEqual([{ id: 'synthetic', title: 'synthetic restart', updatedAt: 123 }])
  })
})
