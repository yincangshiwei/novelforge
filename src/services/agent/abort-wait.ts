export function waitWithAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => finish(() => reject(new Error('操作已取消')))
    const finish = (settle: () => void): void => {
      signal.removeEventListener('abort', abort)
      settle()
    }
    work.then(value => finish(() => resolve(value)), error => finish(() => reject(error)))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

export function waitForApproval(
  signal: AbortSignal,
  register: (resolve: (allowed: boolean) => void) => void,
  cleanup: () => void,
  timeoutMs: number | null = 120_000,
  onTimeout?: () => void,
): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (allowed: boolean): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      cleanup()
      resolve(allowed && !signal.aborted)
    }
    const abort = (): void => finish(false)
    if (signal.aborted) { finish(false); return }
    signal.addEventListener('abort', abort, { once: true })
    if (timeoutMs !== null) timer = setTimeout(() => {
      if (settled) return
      finish(false)
      onTimeout?.()
    }, timeoutMs)
    register(finish)
  })
}
