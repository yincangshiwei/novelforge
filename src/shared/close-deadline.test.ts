import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForCloseResult } from './close-deadline'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

afterEach(() => vi.useRealTimers())

describe('关闭有界等待', () => {
  it.each([true, false, undefined, { success: true }])('仅明确 true 允许退出：%j', async value => {
    vi.useFakeTimers()
    expect(await waitForCloseResult(Promise.resolve(value), 100)).toBe(value === true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['resolve', 'reject'] as const)('超时留窗，晚到 %s 不改变本轮结论，显式重试才重新核验', async mode => {
    vi.useFakeTimers()
    const work = deferred<boolean>()
    const close = vi.fn()
    const closing = waitForCloseResult(work.promise, 100).then(saved => { if (saved) close(); return saved })
    await vi.advanceTimersByTimeAsync(100)
    expect(await closing).toBe(false)
    if (mode === 'resolve') work.resolve(true)
    else work.reject(new Error('晚到保存失败'))
    await Promise.resolve()
    await Promise.resolve()
    expect(close).not.toHaveBeenCalled()
    expect(await waitForCloseResult(work.promise, 100)).toBe(mode === 'resolve')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('立即失败拒绝退出并清理计时器', async () => {
    vi.useFakeTimers()
    expect(await waitForCloseResult(Promise.reject(new Error('保存失败')), 100)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
