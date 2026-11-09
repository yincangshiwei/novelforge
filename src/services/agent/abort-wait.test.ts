import { describe, it, expect, vi, afterEach } from 'vitest'
import { waitForApproval, waitWithAbort } from './abort-wait'

afterEach(() => vi.useRealTimers())
describe('取消与审批等待器', () => {
  it('规则读取期间取消，晚到resolve不改变结果', async () => {
    const controller = new AbortController()
    let resolve!: (value: string[]) => void
    const work = new Promise<string[]>(r => { resolve = r })
    const waiting = waitWithAbort(work, controller.signal)
    const assertion = expect(waiting).rejects.toThrow('取消')
    controller.abort(); await assertion
    resolve(['late']); await Promise.resolve()
    await expect(waiting).rejects.toThrow('取消')
  })
  it('审批取消single-settle，晚到允许无效且清理一次', async () => {
    const controller = new AbortController(), cleanup = vi.fn()
    let allow!: (value: boolean) => void
    const waiting = waitForApproval(controller.signal, r => { allow = r }, cleanup)
    controller.abort(); allow(true)
    expect(await waiting).toBe(false)
    expect(cleanup).toHaveBeenCalledOnce()
  })
  it('预取消不注册审批，超时清理', async () => {
    vi.useFakeTimers()
    const controller = new AbortController(), register = vi.fn(), cleanup = vi.fn()
    controller.abort()
    expect(await waitForApproval(controller.signal, register, cleanup)).toBe(false)
    expect(register).not.toHaveBeenCalled()
    const waiting = waitForApproval(new AbortController().signal, register, cleanup, 10)
    await vi.advanceTimersByTimeAsync(10)
    expect(await waiting).toBe(false)
    expect(cleanup).toHaveBeenCalledTimes(2)
  })
})
