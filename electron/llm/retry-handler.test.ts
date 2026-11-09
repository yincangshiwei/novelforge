import { describe, it, expect, vi } from 'vitest'
import { withRetry, withStreamRetry } from './retry-handler'

// 带 HTTP 状态码的错误对象（模拟 openai/gemini provider 中的 HttpError）
class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

describe.each([['withRetry', withRetry], ['withStreamRetry', withStreamRetry]] as const)('%s取消', (_name, retry) => {
  it('预取消不执行请求', async () => {
    const controller = new AbortController()
    controller.abort()
    const fn = vi.fn().mockResolvedValue(undefined)
    await expect(retry(fn, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fn).not.toHaveBeenCalled()
  })

  it('AbortError优先于status和网络文案，不重试', async () => {
    const error = Object.assign(new Error('network failed'), { name: 'AbortError', status: 503 })
    const fn = vi.fn().mockRejectedValue(error)
    await expect(retry(fn)).rejects.toBe(error)
    expect(fn).toHaveBeenCalledOnce()
  })

  it('退避取消立即结束且清理timer和监听器', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const remove = vi.spyOn(controller.signal, 'removeEventListener')
      const fn = vi.fn().mockRejectedValue(new HttpError(503, 'unavailable'))
      const pending = retry(fn, { signal: controller.signal, baseDelayMs: 30000 })
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      await Promise.resolve()
      expect(vi.getTimerCount()).toBe(1)
      controller.abort()
      await rejected
      expect(fn).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    } finally { vi.useRealTimers() }
  })
})

describe('withRetry', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('success')
    const result = await withRetry(fn, { maxRetries: 2 })
    expect(result).toBe('success')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries on 429 error', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new HttpError(429, 'rate limit'))
      .mockResolvedValueOnce('ok')

    const result = await withRetry(fn, { maxRetries: 2, baseDelayMs: 0 })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('retries on 503 error', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new HttpError(503, 'unavailable'))
      .mockResolvedValueOnce('ok')

    const result = await withRetry(fn, { maxRetries: 1, baseDelayMs: 0 })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry on 400 error', async () => {
    const fn = vi.fn().mockRejectedValue(new HttpError(400, 'bad request'))

    await expect(withRetry(fn, { maxRetries: 2 })).rejects.toThrow('bad request')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry on 401 error', async () => {
    const fn = vi.fn().mockRejectedValue(new HttpError(401, 'unauthorized'))

    await expect(withRetry(fn, { maxRetries: 2 })).rejects.toThrow('unauthorized')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('throws after exhausting retries', async () => {
    const fn = vi.fn().mockRejectedValue(new HttpError(429, 'always rate limited'))

    await expect(
      withRetry(fn, { maxRetries: 2, baseDelayMs: 1 })
    ).rejects.toThrow('always rate limited')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('retries on network TypeError', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce('recovered')

    const result = await withRetry(fn, { maxRetries: 1, baseDelayMs: 0 })
    expect(result).toBe('recovered')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry on AbortError', async () => {
    const abortError = new Error('The user aborted a request')
    abortError.name = 'AbortError'
    const fn = vi.fn().mockRejectedValue(abortError)

    await expect(withRetry(fn, { maxRetries: 2 })).rejects.toThrow('aborted')
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
