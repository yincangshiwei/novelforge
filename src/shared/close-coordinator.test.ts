import { describe, expect, it, vi } from 'vitest'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

describe('整体关闭协调屏障', () => {
  it.each(['Agent', 'workflow'])('%s 先完成不开放新任务，并发关闭复用同次收尾', async () => {
    vi.resetModules()
    const { coordinateClose, isCloseCoordinating } = await import('./close-coordinator')
    const slow = deferred<boolean>()
    const fastDrain = vi.fn(async () => true)
    const slowDrain = vi.fn(() => slow.promise)
    const first = coordinateClose([fastDrain, slowDrain])
    const second = coordinateClose([fastDrain, slowDrain])
    expect(second).toBe(first)
    expect(isCloseCoordinating()).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(isCloseCoordinating()).toBe(true)
    slow.resolve(true)
    expect(await first).toBe(true)
    expect(fastDrain).toHaveBeenCalledOnce()
    expect(slowDrain).toHaveBeenCalledOnce()
    expect(isCloseCoordinating()).toBe(true)
    expect(await coordinateClose([fastDrain, slowDrain])).toBe(true)
    expect(fastDrain).toHaveBeenCalledTimes(2)
  })

  it.each(['false', 'reject'] as const)('一侧 %s 等待另一侧后释放整体禁入，允许显式重试', async mode => {
    vi.resetModules()
    const { coordinateClose, isCloseCoordinating } = await import('./close-coordinator')
    const slow = deferred<boolean>()
    const closing = coordinateClose([
      async () => { if (mode === 'reject') throw new Error('保存失败'); return false },
      () => slow.promise,
    ])
    await Promise.resolve()
    await Promise.resolve()
    expect(isCloseCoordinating()).toBe(true)
    slow.resolve(true)
    expect(await closing).toBe(false)
    expect(isCloseCoordinating()).toBe(false)
    expect(await coordinateClose([async () => true, async () => true])).toBe(true)
    expect(isCloseCoordinating()).toBe(true)
  })
})
