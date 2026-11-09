import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import type { AgentOperationRequest } from '../../src/shared/agent-operation-protocol'
import { AgentOperationJournal, checkOperationCancellation, withOperationCommit, type JournalDatabase } from './agent-operation-journal'

const harness = vi.hoisted(() => ({ projectDb: undefined as unknown, scope: '' }))
vi.mock('better-sqlite3', () => ({ default: class { constructor() { throw new Error('测试禁止加载 native 数据库') } } }))
vi.mock('../database', () => ({ getProjectDb: () => harness.projectDb, getCurrentProjectPath: () => harness.scope }))
vi.mock('../utils/config-utils', () => ({ VELA_HOME: 'journal-tests-unused-home' }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function transactionAdapter(db: DatabaseSync) {
  return {
    exec: (sql: string) => db.exec(sql),
    prepare: (sql: string) => db.prepare(sql),
    transaction: <T>(work: () => T) => () => {
      db.exec('BEGIN')
      try {
        const value = work()
        db.exec('COMMIT')
        return value
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
}

describe('操作日志：真实 SQLite 持久化与提交证据', () => {
  let db: DatabaseSync
  let projectDb: DatabaseSync
  let journal: AgentOperationJournal
  let adapter: JournalDatabase
  let failInsert: boolean
  let failFinish: boolean
  const request = (patch: Partial<AgentOperationRequest> = {}): AgentOperationRequest => ({
    operationId: 'operation-1', callId: 'call-1', turnId: 'turn-1', conversationId: 'conversation-1',
    scope: harness.scope, toolName: 'apply', channel: 'db:draft-apply-content', args: [{ draftId: 'draft-1', content: 'private draft body' }],
    ...patch,
  })
  const row = () => db.prepare('SELECT * FROM agent_operations WHERE operation_id=?').get('operation-1')
  const markerCount = () => projectDb.prepare('SELECT count(*) AS total FROM agent_operation_commits').get()?.total
  const restart = () => { journal = new AgentOperationJournal(adapter) }

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    projectDb = new DatabaseSync(':memory:')
    projectDb.exec('CREATE TABLE business (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
    harness.scope = path.resolve(process.cwd())
    harness.projectDb = transactionAdapter(projectDb)
    failInsert = false
    failFinish = false
    adapter = {
      exec: sql => db.exec(sql),
      prepare: sql => {
        const statement = db.prepare(sql)
        return {
          run: (...args: unknown[]) => {
            if (failInsert && sql.startsWith('INSERT INTO agent_operations')) throw new Error('意图磁盘写入失败')
            if (failFinish && sql.startsWith('UPDATE agent_operations SET state=?')) throw new Error('全局回执磁盘写入失败')
            return statement.run(...args as Parameters<typeof statement.run>)
          },
          get: (...args: unknown[]) => statement.get(...args as Parameters<typeof statement.get>),
          all: (...args: unknown[]) => statement.all(...args as Parameters<typeof statement.all>),
        }
      },
      close: () => db.close(),
    }
    journal = new AgentOperationJournal(adapter)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    harness.projectDb = undefined
    db.close()
    projectDb.close()
  })

  it('初始化空日志', () => {
    expect(journal.list(harness.scope)).toEqual([])
  })

  it('旧日志缺会话列时迁移并保持旧记录，新调用可保存', async () => {
    db.exec('DROP TABLE agent_operations')
    db.exec(`CREATE TABLE agent_operations (
      operation_id TEXT PRIMARY KEY, call_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      scope TEXT NOT NULL, tool_name TEXT NOT NULL, channel TEXT NOT NULL, fingerprint TEXT NOT NULL,
      target TEXT, content_hash TEXT, state TEXT NOT NULL, value_json TEXT, updated_at INTEGER NOT NULL)`)
    db.prepare('INSERT INTO agent_operations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('old', 'old-call', 'old-turn', harness.scope, 'old-tool', 'old-channel', 'old-fingerprint', 'old-target', null, 'unknown', null, 1)
    restart()
    expect(db.prepare('SELECT conversation_id FROM agent_operations WHERE operation_id=?').get('old')?.conversation_id).toBeNull()
    const dispatch = vi.fn(() => ({ success: true }))
    expect(await journal.invoke(request(), 1, dispatch, false)).toMatchObject({ state: 'committed' })
    expect(row()?.conversation_id).toBe('conversation-1')
  })

  it.each([{ args: [undefined] }, { args: [NaN] }, { args: [Infinity] }, { args: [{ value: undefined }] }])('非法参数零 dispatch：%j', async ({ args }) => {
    const dispatch = vi.fn(() => ({ success: true }))
    expect(await journal.invoke(request({ args }), 1, dispatch, false)).toMatchObject({ state: 'not_committed', error: '无效的操作参数' })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('同目标未知写入跨工具、跨 ID 和重启仍阻止新副作用', async () => {
    const first = vi.fn(() => { throw new Error('提交状态未知') })
    expect(await journal.invoke(request(), 1, first, false)).toMatchObject({ state: 'unknown' })
    restart()
    const next = vi.fn(() => ({ success: true }))
    const result = await journal.invoke(request({ operationId: 'new-operation', callId: 'new-call', toolName: 'other-tool' }), 1, next, false)
    expect(result).toMatchObject({ state: 'not_committed' })
    expect(result.error).toContain('同目标操作')
    expect(next).not.toHaveBeenCalled()
  })

  it('事务回滚保留结构化业务冲突且无 marker 或业务副作用', async () => {
    const conflict = { success: false, conflict: true, currentHash: 'current', currentUpdatedAt: 7 }
    const result = await journal.invoke(request(), 1, () => withOperationCommit(() => {
      projectDb.prepare('INSERT INTO business VALUES (?,?)').run('draft-1', 'rollback')
      return conflict
    }), false)
    expect(result).toMatchObject({ state: 'not_committed', value: conflict })
    expect(projectDb.prepare('SELECT count(*) AS total FROM business').get()?.total).toBe(0)
    expect(markerCount()).toBe(0)
    restart()
    const dispatch = vi.fn()
    expect(await journal.invoke(request(), 1, dispatch, false)).toMatchObject({ state: 'not_committed', value: conflict })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('begin 写盘失败时零 dispatch', async () => {
    failInsert = true
    const dispatch = vi.fn(() => ({ success: true }))
    expect(await journal.invoke(request(), 1, dispatch, false)).toMatchObject({ state: 'not_committed' })
    expect(dispatch).not.toHaveBeenCalled()
    expect(row()).toBeUndefined()
  })

  it.each([
    { args: [{ draftId: 'draft-1', content: 'different body' }] },
    { conversationId: 'different-session' },
    { callId: 'different-call' },
    { turnId: 'different-turn' },
  ])('相同 ID 身份或参数冲突不再次派发：%j', async patch => {
    const dispatch = vi.fn(() => ({ success: true }))
    await journal.invoke(request(), 1, dispatch, false)
    expect(await journal.invoke(request(patch), 1, dispatch, false)).toMatchObject({ state: 'not_committed', error: '操作ID参数冲突' })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('running 重复请求单飞，不同 sender 不共享运行结果', async () => {
    const gate = deferred<{ success: boolean }>()
    const dispatch = vi.fn(() => gate.promise)
    const first = journal.invoke(request(), 1, dispatch, false)
    const duplicate = journal.invoke(request(), 1, dispatch, false)
    expect(await journal.invoke(request(), 2, dispatch, false)).toMatchObject({ state: 'not_committed' })
    await Promise.resolve()
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(row()?.state).toBe('running')
    gate.resolve({ success: true })
    expect(await first).toEqual(await duplicate)
    expect(row()?.state).toBe('committed')
  })

  it('预取消与 begin 后派发前取消都不调用工具', async () => {
    const dispatch = vi.fn(() => ({ success: true }))
    journal.cancel('call-1', 1)
    expect(await journal.invoke(request(), 1, dispatch, false)).toMatchObject({ state: 'not_committed' })
    expect(row()).toBeUndefined()
    restart()
    const result = journal.invoke(request(), 1, dispatch, false)
    journal.cancel('call-1', 1)
    expect(await result).toMatchObject({ state: 'not_committed' })
    expect(dispatch).not.toHaveBeenCalled()
    expect(row()?.state).toBe('not_committed')
  })

  it('取消按 sender 隔离', async () => {
    journal.cancel('call-1', 2)
    const dispatch = vi.fn(() => ({ success: true }))
    expect(await journal.invoke(request(), 1, dispatch, false)).toMatchObject({ state: 'committed' })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('派发后取消且无提交证据必须 unknown', async () => {
    const started = deferred<void>()
    const release = deferred<void>()
    const result = journal.invoke(request(), 1, async () => {
      started.resolve()
      await release.promise
      checkOperationCancellation()
      return { success: true }
    }, false)
    await started.promise
    journal.cancel('call-1', 1)
    release.resolve()
    expect(await result).toMatchObject({ state: 'unknown' })
    expect(row()?.state).toBe('unknown')
  })

  it('真实事务已提交后取消、晚到异常仍保留 committed', async () => {
    const committed = deferred<void>()
    const release = deferred<void>()
    const result = journal.invoke(request(), 1, async () => {
      withOperationCommit(() => {
        projectDb.prepare('INSERT INTO business VALUES (?,?)').run('draft-1', 'written')
        return { success: true, draftId: 'draft-1' }
      })
      committed.resolve()
      await release.promise
      checkOperationCancellation()
    }, false)
    await committed.promise
    journal.cancel('call-1', 1)
    release.resolve()
    expect(await result).toMatchObject({ state: 'committed', value: { success: true, draftId: 'draft-1' } })
    expect(projectDb.prepare('SELECT value FROM business').get()?.value).toBe('written')
    expect(markerCount()).toBe(1)
  })

  it('业务事务失败时业务数据与 marker 一起回滚', async () => {
    const result = await journal.invoke(request(), 1, () => withOperationCommit(() => {
      projectDb.prepare('INSERT INTO business VALUES (?,?)').run('draft-1', 'must rollback')
      throw new Error('业务故障')
    }), false)
    expect(result.state).toBe('not_committed')
    expect(projectDb.prepare('SELECT count(*) AS total FROM business').get()?.total).toBe(0)
    expect(markerCount()).toBe(0)
  })

  it('marker 插入失败时真实业务写入也回滚', async () => {
    projectDb.exec(`CREATE TABLE agent_operation_commits (
      operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, value_json TEXT NOT NULL, committed_at INTEGER NOT NULL);
      CREATE TRIGGER reject_marker BEFORE INSERT ON agent_operation_commits BEGIN SELECT RAISE(ABORT, 'marker failure'); END;`)
    const result = await journal.invoke(request(), 1, () => withOperationCommit(() => {
      projectDb.prepare('INSERT INTO business VALUES (?,?)').run('draft-1', 'must rollback')
      return { success: true }
    }), false)
    expect(result.state).toBe('not_committed')
    expect(projectDb.prepare('SELECT count(*) AS total FROM business').get()?.total).toBe(0)
    expect(markerCount()).toBe(0)
  })

  it('全局 finish 失败后从真实事务 marker 恢复且不重放', async () => {
    failFinish = true
    const dispatch = vi.fn(() => withOperationCommit(() => {
      projectDb.prepare('INSERT INTO business VALUES (?,?)').run('draft-1', 'written')
      return { success: true, draftId: 'draft-1', content: 'private body' }
    }))
    expect(await journal.invoke(request(), 1, dispatch, false)).toMatchObject({ state: 'committed' })
    expect(row()?.state).toBe('running')
    failFinish = false
    restart()
    expect(row()?.state).toBe('unknown')
    expect(await journal.invoke(request(), 1, dispatch, false)).toEqual({ state: 'committed', value: { success: true, draftId: 'draft-1', content: 'private body' } })
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(row()?.state).toBe('committed')
  })

  it('本地 SQL 回执完整保留字段，重启返回真实事务结果', async () => {
    const value = { success: true, content: 'returned body', text: 'returned text', body: 'returned payload', args: ['returned arg'] }
    const dispatch = vi.fn(() => withOperationCommit(() => value))
    expect(await journal.invoke(request(), 1, dispatch, false)).toEqual({ state: 'committed', value })
    expect(JSON.parse(String(row()?.value_json))).toEqual(value)
    expect(JSON.parse(String(projectDb.prepare('SELECT value_json FROM agent_operation_commits').get()?.value_json))).toEqual(value)
    restart()
    expect(await journal.invoke(request(), 1, dispatch, false)).toEqual({ state: 'committed', value })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('本地 SQL 回执超过 32KB 时业务与 marker 均回滚', async () => {
    const result = await journal.invoke(request(), 1, () => withOperationCommit(() => {
      projectDb.prepare('INSERT INTO business VALUES (?,?)').run('draft-1', 'must rollback')
      return { success: true, body: '超'.repeat(12 * 1024) }
    }), false)
    expect(result).toMatchObject({ state: 'not_committed', error: '操作回执超出持久化限制' })
    expect(projectDb.prepare('SELECT count(*) AS total FROM business').get()?.total).toBe(0)
    expect(markerCount()).toBe(0)
  })

  it('中断 running 重启标记 unknown，无证据不重放', async () => {
    const gate = deferred<void>()
    const dispatch = vi.fn(() => gate.promise)
    const running = journal.invoke(request(), 1, dispatch, false)
    await Promise.resolve()
    restart()
    expect(row()?.state).toBe('unknown')
    expect(await journal.invoke(request(), 1, dispatch, false)).toMatchObject({ state: 'unknown' })
    expect(journal.list(harness.scope)[0]?.state).toBe('unknown')
    expect(dispatch).toHaveBeenCalledTimes(1)
    gate.resolve()
    await running
  })

  it.each([true, false])('现有文件内容一致=%s 不冒充该操作已提交，也不重放', async matches => {
    const target = path.join(harness.scope, 'package.json')
    const content = fs.readFileSync(target, 'utf8')
    const writeRequest = request({ channel: 'fs:write-file', args: [target, matches ? content : `${content}\nnot-written`] })
    const dispatch = vi.fn(() => { throw new Error('模拟写入后响应丢失') })
    expect(await journal.invoke(writeRequest, 1, dispatch, false)).toMatchObject({ state: 'unknown' })
    restart()
    expect(await journal.invoke(writeRequest, 1, dispatch, false)).toMatchObject({ state: 'unknown' })
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(fs.readFileSync(target, 'utf8')).toBe(content)
  })

  it('read 返回完整正文但不持久化任何正文或执行记录', async () => {
    const value = { success: true, content: 'private read body', text: 'secret text', body: 'secret body' }
    const dispatch = vi.fn(() => value)
    expect(await journal.invoke(request({ channel: 'fs:read-file' }), 1, dispatch, true)).toEqual({ state: 'committed', value })
    expect(db.prepare('SELECT * FROM agent_operations').all()).toEqual([])
    restart()
    await journal.invoke(request({ channel: 'fs:read-file' }), 1, dispatch, true)
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('同进程重复 committed 返回完整结果而不派发', async () => {
    const value = { success: true, content: 'full response body', nested: { text: 'full nested text' } }
    const dispatch = vi.fn(() => value)
    const external = request({ channel: 'mcp:call-tool' })
    expect(await journal.invoke(external, 1, dispatch, false)).toEqual({ state: 'committed', value })
    expect(await journal.invoke(external, 1, dispatch, false)).toEqual({ state: 'committed', value })
    expect(String(row()?.value_json)).not.toContain('full response body')
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it.each(['mcp:call-tool', 'dev:invoke'])('外部 %s 精简 receipt 重启不能伪造完整成功响应', async channel => {
    const value = { success: true, content: 'external response body', requestId: 'external-1' }
    const dispatch = vi.fn(() => value)
    const external = request({ channel })
    expect(await journal.invoke(external, 1, dispatch, false)).toEqual({ state: 'committed', value })
    expect(String(row()?.value_json)).not.toContain('external response body')
    restart()
    const recovered = await journal.invoke(external, 1, dispatch, false)
    expect(recovered).toMatchObject({ state: 'committed', value: { responseUnavailable: true } })
    expect(recovered.value).not.toEqual(value)
    expect(JSON.stringify(recovered.value)).not.toContain('external response body')
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
})
