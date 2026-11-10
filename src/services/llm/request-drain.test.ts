import { describe, expect, it, vi } from 'vitest'
import { registerLLMRequest, trackLLMStart, cancelTrackedLLMRequest, drainLLMRequests } from './request-drain'

describe('关闭前模型请求回执等待', () => {
  it('启动回执迟到时先取消，仍等启动回执并补取消后才能完成', async () => {
    let start!: () => void
    const starting = new Promise<void>(resolve => { start = resolve })
    registerLLMRequest('late')
    trackLLMStart('late', starting)
    const cancel = vi.fn(async () => {})
    let done = false
    const drain = drainLLMRequests(cancel).then(() => { done = true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(cancel).toHaveBeenCalledWith('late')
    expect(done).toBe(false)
    start()
    await drain
    expect(cancel).toHaveBeenCalledTimes(2)
    expect(done).toBe(true)
  })
  it('前台结束不代表取消回执已到，关闭必须等待正在进行的取消', async () => {
    let stop!: () => void
    const ack = new Promise<void>(resolve => { stop = resolve })
    registerLLMRequest('pending')
    void cancelTrackedLLMRequest('pending', () => ack)
    let done = false
    const drain = drainLLMRequests(async () => {}).then(() => { done = true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(done).toBe(false)
    stop()
    await drain
    expect(done).toBe(true)
  })
  it('取消回执失败则不批准关闭，可重试取消后关闭', async () => {
    registerLLMRequest('failed')
    await expect(drainLLMRequests(async () => { throw new Error('IPC failed') })).rejects.toThrow('IPC failed')
    await expect(drainLLMRequests(async () => {})).resolves.toBeUndefined()
  })
})
