export const CLOSE_DRAIN_TIMEOUT_MS = 30_000
export const CLOSE_HANDSHAKE_TIMEOUT_MS = 35_000

export function waitForCloseResult(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false
    const finish = (saved: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(saved)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    work.then(value => finish(value === true), () => finish(false))
  })
}
