import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchWithTimeout, withAbortSignal, withDeadline } from './fetch-with-timeout'
import { proxyFetch } from './proxy-fetch'

vi.mock('./proxy-fetch', () => ({ proxyFetch: vi.fn() }))
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('完整网络消费时限', () => {
  it.each([true, false])('响应头成功=%s 但读体挂起，超时中断且保持 TimeoutError', async ok => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const cancel = vi.fn(async () => {})
    const body = () => new Promise<never>(() => {})
    vi.mocked(proxyFetch).mockImplementation(async (_url, init) => {
      signal = init?.signal ?? undefined
      return { ok, json: body, text: body, body: { cancel } } as unknown as Response
    })
    const result = withDeadline(async deadlineSignal => {
      const response = await fetchWithTimeout('http://synthetic.test', { signal: deadlineSignal }, 1000)
      return withAbortSignal(() => ok ? response.json() : response.text(), deadlineSignal, () => { void response.body?.cancel() })
    }, 10)
    const assertion = expect(result).rejects.toMatchObject({ name: 'TimeoutError' })
    await vi.advanceTimersByTimeAsync(10)
    await assertion
    expect(signal?.aborted).toBe(true)
    expect(cancel).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('读流总时限覆盖首块后停流', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn(async () => {})
    const result = withDeadline(async signal => {
      await Promise.resolve('first chunk')
      return withAbortSignal(() => new Promise<never>(() => {}), signal, () => { void cancel() })
    }, 10)
    const assertion = expect(result).rejects.toMatchObject({ name: 'TimeoutError' })
    await vi.advanceTimersByTimeAsync(10)
    await assertion
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('外部取消是 AbortError，正常结束清理时限', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const result = withDeadline(() => new Promise<never>(() => {}), 100, controller.signal)
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await assertion
    expect(await withDeadline(async () => 'ok', 100)).toBe('ok')
    expect(vi.getTimerCount()).toBe(0)
  })
})
