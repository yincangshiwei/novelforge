// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ipc } from './ipc-client'

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); delete (window as unknown as { velaAPI?: unknown }).velaAPI })
function setup(invoke: ReturnType<typeof vi.fn>) {
  Object.assign(window, { velaAPI: { invoke } })
  return vi.spyOn(console, 'error').mockImplementation(() => {})
}
describe('IPC错误追踪', () => {
  it('拒绝记录通道和错误链，不记录传入内容', async () => {
    const invoke = vi.fn().mockRejectedValueOnce(new Error('network api_key=private')).mockResolvedValue({ success: true })
    const error = setup(invoke)
    await expect(ipc.invoke('fs:write-file', '/project/file', 'private-novel')).rejects.toThrow('network')
    expect(error.mock.calls[0][0]).toContain('channel=fs:write-file')
    expect(error.mock.calls[0][0]).not.toContain('private')
    expect(invoke.mock.calls[1][0]).toBe('log:write')
  })
  it('业务失败保持返回值，只记录错误而不记录结果正文', async () => {
    const result = { success: false, error: 'save failed', content: 'private-novel' }
    const invoke = vi.fn().mockResolvedValueOnce(result).mockResolvedValue({ success: true })
    const error = setup(invoke)
    expect(await ipc.invoke('fs:write-file', '/project/file', 'private-novel')).toBe(result)
    expect(error.mock.calls[0][0]).toContain('save failed')
    expect(error.mock.calls[0][0]).not.toContain('private-novel')
  })
  it('日志通道失败不会递归调用自身', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('disk failed'))
    setup(invoke)
    await expect(ipc.invoke('log:write', 'error', 'Test', 'message')).rejects.toThrow('disk failed')
    expect(invoke).toHaveBeenCalledTimes(1)
  })
  it('超时留下通道和耗时但不伪称取消底层操作', async () => {
    vi.useFakeTimers()
    const invoke = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue({ success: true })
    const error = setup(invoke)
    const pending = ipc.invoke('fs:write-file', '/project/file', 'content')
    const rejected = expect(pending).rejects.toMatchObject({ name: 'IPCTimeoutError' })
    await vi.advanceTimersByTimeAsync(30000)
    await rejected
    expect(error.mock.calls[0][0]).toContain('elapsedMs=30000')
  })
})
