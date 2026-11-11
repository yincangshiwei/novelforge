import { afterEach, describe, expect, it, vi } from 'vitest'
import { ActiveTimeout } from './active-timeout'
import { waitForApproval } from './abort-wait'
import { resolveAttentionPrefs, approvalTimeoutMs, validAttentionRequest } from '../../shared/attention-prefs'

afterEach(() => vi.useRealTimers())
describe('人工等待和活动超时', () => {
  it('人工等待暂停执行时间，多次pause与release不会提前恢复', async () => {
    vi.useFakeTimers()
    const expire = vi.fn()
    const timer = new ActiveTimeout(100, expire)
    await vi.advanceTimersByTimeAsync(40)
    const release1 = timer.pause()
    const release2 = timer.pause()
    await vi.advanceTimersByTimeAsync(10000)
    expect(timer.elapsedMs).toBe(40)
    release1(); release1()
    await vi.advanceTimersByTimeAsync(10000)
    expect(expire).not.toHaveBeenCalled()
    release2()
    await vi.advanceTimersByTimeAsync(59)
    expect(expire).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(expire).toHaveBeenCalledOnce()
    timer.dispose()
  })
  it('不限审批仍可取消，清理只执行一次且无残留定时器', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const cleanup = vi.fn()
    let approve!: (allowed: boolean) => void
    const waiting = waitForApproval(controller.signal, resolve => { approve = resolve }, cleanup, null)
    await vi.advanceTimersByTimeAsync(3600000)
    expect(cleanup).not.toHaveBeenCalled()
    controller.abort()
    expect(await waiting).toBe(false)
    approve(true)
    expect(cleanup).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('审批到期拒绝并明确发出超时反馈', async () => {
    vi.useFakeTimers()
    const expired = vi.fn()
    const waiting = waitForApproval(new AbortController().signal, () => {}, vi.fn(), 100, expired)
    await vi.advanceTimersByTimeAsync(100)
    expect(await waiting).toBe(false)
    expect(expired).toHaveBeenCalledOnce()
  })
  it('旧设置默认10分钟，支持不限和静音，非法设置安全回退', () => {
    expect(resolveAttentionPrefs()).toEqual({ approvalTimeoutMinutes: 10, soundEnabled: true })
    expect(approvalTimeoutMs(resolveAttentionPrefs({ attention: { approvalTimeoutMinutes: 0, soundEnabled: false } }))).toBeNull()
    expect(approvalTimeoutMs(resolveAttentionPrefs({ attention: { approvalTimeoutMinutes: 30 } }))).toBe(1800000)
    expect(resolveAttentionPrefs({ attention: { approvalTimeoutMinutes: -1, soundEnabled: 'false' } })).toEqual(resolveAttentionPrefs())
    expect(validAttentionRequest({ id: 'wait-1', kind: 'approval' })).toBe(true)
    expect(validAttentionRequest({ id: '../private', kind: 'approval' })).toBe(false)
  })
})
