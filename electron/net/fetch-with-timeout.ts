/**
 * 带超时的出站 fetch —— 主进程共用
 *
 * 2026-09-25 从 `electron/embedding.ts` 挪来：它当时的注释就写着「导出自 T1：Ollama pull
 * 等长任务复用」，即早已是共用工具，只是住在嵌入服务模块里。挪出来是为了让 LLM provider
 * 能直接用它，而不必从「嵌入服务」import 网络工具（依赖方向反了）。
 */
import { proxyFetch } from './proxy-fetch'

/** 默认超时：API 挂起时不能无限阻塞调用方 */
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000

/**
 * 带 AbortController 超时兜底的 fetch（长任务传 `timeoutMs` 覆盖默认 10s）。
 *
 * ⚠️ **abort 兜底**（2026-08-29 冒烟实测根因）：API 请求挂起（限流/网络）时，
 * undici 对挂起连接的 abort reject 可能延迟 ~20s（实测），IPC 30s 窗口内降级链来不及完成
 * → kb:import-text 三次超时 → 后处理管线中止。`Promise.race` 保证超时即 abort + 立即 reject，
 * 不依赖 fetch 对 abort 信号的响应及时性。**改回单纯传 signal 会重新引入这个延迟。**
 */
export function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  const signal = init.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal
  let timer: ReturnType<typeof setTimeout> | undefined
  const request = withAbortSignal(() => proxyFetch(url, { ...init, signal }), signal)
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new DOMException(`Request timed out after ${timeoutMs}ms`, 'TimeoutError')
      reject(error)
      controller.abort(error)
    }, timeoutMs)
  })
  return Promise.race([request, timeoutPromise]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

export function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('This operation was aborted', 'AbortError')
}

/** 即使底层请求/读体未响应 abort，也立即结束等待，并清理订阅。 */
export function withAbortSignal<T>(
  work: () => Promise<T>,
  signal?: AbortSignal | null,
  onAbort?: () => void,
): Promise<T> {
  try {
    throwIfAborted(signal)
  } catch (error) {
    onAbort?.()
    return Promise.reject(error)
  }
  if (!signal) return work()
  let abort: () => void
  return new Promise<T>((resolve, reject) => {
    abort = (): void => {
      onAbort?.()
      reject(signal.reason ?? new DOMException('This operation was aborted', 'AbortError'))
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      throwIfAborted(signal)
      work().then(resolve, reject)
    } catch (error) {
      reject(error)
    }
  }).finally(() => signal.removeEventListener('abort', abort))
}

export function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
  externalSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController()
  const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal
  const timer = setTimeout(() => controller.abort(new DOMException(`Request lifecycle timed out after ${timeoutMs}ms`, 'TimeoutError')), timeoutMs)
  return withAbortSignal(() => work(signal), signal).finally(() => clearTimeout(timer))
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return withAbortSignal(() => new Promise<void>(resolve => {
    timer = setTimeout(resolve, ms)
  }), signal, () => {
    if (timer !== undefined) clearTimeout(timer)
  }).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}
