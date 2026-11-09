import { describe, it, expect, vi } from 'vitest'
import { ArchiveQueue } from './archive-queue'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

describe('归档顺序与重试', () => {
  it('同会话严格串行快照，跨会话独立；flush等待最新版本', async () => {
    const first = deferred<{ success: boolean }>()
    const write = vi.fn(async (_id: string, snapshot: string) => snapshot === 'a1' ? first.promise : { success: true })
    const queue = new ArchiveQueue(write, vi.fn())
    const a1 = queue.save('a', 'a1'), a2 = queue.save('a', 'a2'), b = queue.save('b', 'b1')
    await b
    expect(write.mock.calls).toEqual([['a', 'a1'], ['b', 'b1']])
    expect(queue.states.get('a')).toMatchObject({ status: 'pending', version: 2, savedVersion: 0 })
    let flushed = false
    const flush = queue.flush().then(result => { flushed = true; return result })
    await Promise.resolve(); expect(flushed).toBe(false)
    first.resolve({ success: true })
    await Promise.all([a1, a2])
    expect(await flush).toBe(true)
    expect(write.mock.calls.at(-1)).toEqual(['a', 'a2'])
    expect(queue.states.get('a')).toMatchObject({ status: 'saved', version: 2, savedVersion: 2 })
  })
  it.each(['reject', 'false'])('%s保存失败不算完成，flush重试最新快照', async mode => {
    let fail = true
    const write = vi.fn(async () => {
      if (fail && mode === 'reject') throw new Error('disk')
      return { success: !fail }
    })
    const queue = new ArchiveQueue(write, vi.fn())
    expect(await queue.save('a', 'latest')).toBe(false)
    expect(queue.states.get('a')?.status).toBe('failed')
    expect(await queue.flush()).toBe(false)
    fail = false
    expect(await queue.flush()).toBe(true)
    expect(write.mock.calls).toHaveLength(3)
    expect(queue.states.get('a')?.savedVersion).toBe(3)
  })
  it('挂起写入后删除排队，晚到保存不得复活；删除失败可重试', async () => {
    const first = deferred<{ success: boolean }>()
    const order: string[] = []
    const queue = new ArchiveQueue(async () => { await first.promise; order.push('write'); return { success: true } }, vi.fn())
    const saving = queue.save('a', 'old')
    let fail = true
    const erase = vi.fn(async () => { order.push('delete'); return { success: !fail } })
    const deleting = queue.remove('a', erase)
    expect(await queue.save('a', 'late')).toBe(false)
    expect(erase).not.toHaveBeenCalled()
    first.resolve({ success: true }); await saving
    expect(await deleting).toBe(false)
    expect(order).toEqual(['write', 'delete'])
    fail = false
    expect(await queue.flush()).toBe(true)
    expect(order).toEqual(['write', 'delete', 'delete'])
  })
})
