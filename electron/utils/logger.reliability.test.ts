import { Writable } from 'node:stream'
import fs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', () => ({ default: {
  existsSync: vi.fn(() => true), mkdirSync: vi.fn(), readdirSync: vi.fn(() => []),
  createWriteStream: vi.fn(), appendFileSync: vi.fn(),
} }))
vi.mock('./config-utils', () => ({
  VELA_HOME: '/isolated', GLOBAL_CONFIG_PATH: '/isolated/config.json', DEFAULT_GLOBAL_CONFIG: {},
  readJsonFile: () => ({}),
}))
afterEach(() => { vi.restoreAllMocks(); vi.resetModules() })

describe('日志落盘可靠性', () => {
  it('异步磁盘故障保留脱敏原消息，应急写入后仍可重建主日志', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = new Writable({ write(_chunk, _encoding, callback) { callback(new Error('ENOSPC')) } })
    const recovered = new Writable({ write(_chunk, _encoding, callback) { callback() } })
    vi.mocked(fs.createWriteStream).mockReturnValueOnce(broken as fs.WriteStream).mockReturnValueOnce(recovered as fs.WriteStream)
    const { logger, LogLevel } = await import('./logger')
    expect(await logger.record(LogLevel.ERROR, 'Test', 'requestId=req api_key=secret')).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fs.appendFileSync).toHaveBeenCalledWith(expect.stringContaining('novelforge-emergency-'), expect.stringContaining('requestId=req'), 'utf8')
    expect(String(vi.mocked(fs.appendFileSync).mock.calls.at(-1)?.[1])).not.toContain('secret')
    expect(await logger.record(LogLevel.INFO, 'Test', 'recovered')).toBe(true)
    expect(await logger.flushAndClose()).toBe(true)
  })
  it('同步初始化失败不会锁死当天路径，下次调用可恢复', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(fs.createWriteStream).mockImplementationOnce(() => { throw new Error('EACCES') })
    const stream = new Writable({ write(_chunk, _encoding, callback) { callback() } })
    vi.mocked(fs.createWriteStream).mockReturnValueOnce(stream as fs.WriteStream)
    const { logger, LogLevel } = await import('./logger')
    expect(await logger.record(LogLevel.INFO, 'Test', 'first')).toBe(false)
    expect(await logger.record(LogLevel.INFO, 'Test', 'next')).toBe(true)
    await logger.flushAndClose()
  })
  it('关闭等待尚未完成的写入，超时明确失败', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let release!: () => void
    const stream = new Writable({ write(_chunk, _encoding, callback) { release = () => callback() } })
    vi.mocked(fs.createWriteStream).mockReturnValueOnce(stream as fs.WriteStream)
    const { logger, LogLevel } = await import('./logger')
    const writing = logger.record(LogLevel.INFO, 'Test', 'last message')
    const closing = logger.flushAndClose(10)
    expect(await closing).toBe(false)
    release()
    expect(await writing).toBe(true)
    expect(fs.appendFileSync).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('日志关闭等待超时'), 'utf8')
  })
})
