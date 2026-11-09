import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerDevController } from './dev-controller'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  operation: new AbortController(),
  fetch: vi.fn(),
  timeoutMs: 100,
}))
vi.mock('electron', () => ({ app: { isPackaged: false } }))
vi.mock('../security/ipc-guard', () => ({ guardedHandle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => h.handlers.set(channel, handler) }))
vi.mock('../services/agent-operation-journal', () => ({
  currentOperationSignal: () => h.operation.signal,
  checkOperationCancellation: () => {
    if (h.operation.signal.aborted) throw Object.assign(new Error('Operation cancelled'), { name: 'AbortError' })
  },
}))
vi.mock('../utils/config-utils', () => ({
  readJsonFile: () => ({ devMode: { enabled: true, apiBaseUrl: 'https://example.test', timeoutMs: h.timeoutMs } }),
  GLOBAL_CONFIG_PATH: '/mock/config.json', DEFAULT_GLOBAL_CONFIG: {},
}))
vi.mock('../net/proxy-fetch', () => ({ proxyFetch: h.fetch }))
vi.mock('../utils/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('../dev/ipc-metrics', () => ({}))
vi.mock('../dev/db-inspector', () => ({}))
vi.mock('../dev/perf-snapshot', () => ({}))
const call = () => Promise.resolve(h.handlers.get('dev:invoke')!(null, { method: 'POST', path: '/action', body: '{}' }))

beforeEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  h.operation = new AbortController()
  h.handlers.clear()
  registerDevController()
})

describe('开发API真实取消与超时组合', () => {
  it('开始前取消不发出网络请求', async () => {
    h.operation.abort()
    await expect(call()).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.fetch).not.toHaveBeenCalled()
  })
  it('操作取消终止fetch且不冒充timeout', async () => {
    h.fetch.mockImplementation((_url: string, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    }))
    const pending = call()
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    h.operation.abort()
    await rejection
    expect(h.fetch.mock.calls[0][1].signal.aborted).toBe(true)
  })
  it('未取消时仍保留原有超时', async () => {
    vi.useFakeTimers()
    try {
      h.fetch.mockImplementation((_url: string, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }))
      const pending = call()
      await vi.advanceTimersByTimeAsync(h.timeoutMs)
      expect(await pending).toEqual({ success: false, error: '请求超时（100ms）' })
      expect(h.operation.signal.aborted).toBe(false)
    } finally { vi.useRealTimers() }
  })
})
