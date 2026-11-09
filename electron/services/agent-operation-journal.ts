import Database from 'better-sqlite3'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AgentOperationRecord, AgentOperationRequest, AgentOperationResult } from '../../src/shared/agent-operation-protocol'
import { canonicalJson } from '../../src/shared/canonical-json'
import { VELA_HOME } from '../utils/config-utils'
import { getCurrentProjectPath, getProjectDb } from '../database'

interface OperationContext {
  request: AgentOperationRequest
  fingerprint: string
  signal: AbortSignal
  didCommit: boolean
  value?: unknown
}
const storage = new AsyncLocalStorage<OperationContext>()
export const currentOperationSignal = (): AbortSignal | undefined => storage.getStore()?.signal
export function checkOperationCancellation(): void {
  if (currentOperationSignal()?.aborted) throw Object.assign(new Error('操作已取消'), { name: 'AbortError' })
}
const rollbackProof = Symbol('operation-transaction-rollback')
export const isOperationRollback = (error: unknown): boolean => error instanceof Error && Boolean((error as Error & { [rollbackProof]?: boolean })[rollbackProof])

export interface JournalDatabase {
  exec(sql: string): unknown
  prepare(sql: string): {
    run(...args: any[]): unknown
    get(...args: any[]): unknown
    all(...args: any[]): unknown[]
  }
  close(): void
}
const normalizeScope = (scope: string): string => scope ? (process.platform === 'win32' ? path.resolve(scope).toLowerCase() : path.resolve(scope)) : ''
const receiptJson = (value: unknown): string => {
  const json = JSON.stringify(value)
  if (json === undefined || Buffer.byteLength(json) > 32 * 1024) throw new Error('操作回执超出持久化限制')
  return json
}
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const MARKER_SCHEMA = `CREATE TABLE IF NOT EXISTS agent_operation_commits (
  operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, value_json TEXT NOT NULL, committed_at INTEGER NOT NULL)`

export function withOperationCommit<T>(work: () => T): T {
  checkOperationCancellation()
  const context = storage.getStore()
  if (context?.request.scope && normalizeScope(context.request.scope) !== normalizeScope(getCurrentProjectPath() ?? '')) throw Object.assign(new Error('操作项目已切换'), { [rollbackProof]: true })
  const db = getProjectDb()
  if (!db) {
    if (context) throw Object.assign(new Error('项目数据库不可用'), { [rollbackProof]: true })
    return work()
  }
  if (context) db.exec(MARKER_SCHEMA)
  let value: T
  try {
    value = db.transaction(() => {
      const result = work()
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('提交事务不能返回Promise')
      if (result && (result as { success?: boolean }).success === false) {
        throw Object.assign(new Error('业务操作未提交'), { operationFailureValue: result })
      }
      if (context) {
        const json = receiptJson(result)
        db.prepare('INSERT INTO agent_operation_commits VALUES (?, ?, ?, ?)').run(context.request.operationId, context.fingerprint, json, Date.now())
      }
      return result
    })()
  } catch (error) {
    if (error instanceof Error) Object.assign(error, { [rollbackProof]: true })
    throw error
  }
  if (context) { context.didCommit = true; context.value = value }
  return value
}

export class AgentOperationJournal {
  private active = new Map<string, { fingerprint: string; callId: string; senderId: number; controller: AbortController; promise: Promise<AgentOperationResult> }>()
  private cancelled = new Map<string, number>()
  private completed = new Map<string, { fingerprint: string; result: AgentOperationResult }>()
  constructor(private db: JournalDatabase) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_operations (
      operation_id TEXT PRIMARY KEY, call_id TEXT NOT NULL, turn_id TEXT NOT NULL, conversation_id TEXT,
      scope TEXT NOT NULL, tool_name TEXT NOT NULL, channel TEXT NOT NULL, fingerprint TEXT NOT NULL,
      target TEXT, content_hash TEXT, state TEXT NOT NULL, value_json TEXT, updated_at INTEGER NOT NULL)`)
    const columns = db.prepare('PRAGMA table_info(agent_operations)').all() as { name: string }[]
    if (!columns.some(column => column.name === 'conversation_id')) db.exec('ALTER TABLE agent_operations ADD COLUMN conversation_id TEXT')
    db.exec('CREATE INDEX IF NOT EXISTS agent_operations_scope_target_state ON agent_operations(scope, target, state)')
    db.prepare("UPDATE agent_operations SET state='unknown' WHERE state='running'").run()
  }
  private row(id: string): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM agent_operations WHERE operation_id=?').get(id) as Record<string, unknown> | undefined
  }
  private finish(id: string, state: AgentOperationResult['state'], value?: unknown): void {
    const channel = this.row(id)?.channel
    const external = channel === 'dev:invoke' || channel === 'mcp:call-tool'
    const json = external ? receiptJson({ success: state === 'committed', responseUnavailable: true })
      : value === undefined ? null : receiptJson(value)
    this.db.prepare('UPDATE agent_operations SET state=?, value_json=?, updated_at=? WHERE operation_id=?').run(state, json, Date.now(), id)
  }
  cancel(callId: string, senderId: number): void {
    const key = `${senderId}:${callId}`
    this.cancelled.set(key, Date.now())
    for (const [id, at] of this.cancelled) if (Date.now() - at > 300_000) this.cancelled.delete(id)
    if (this.cancelled.size > 2000) this.cancelled.delete(this.cancelled.keys().next().value!)
    for (const entry of this.active.values()) if (entry.callId === callId && entry.senderId === senderId) entry.controller.abort()
  }
  async invoke(request: AgentOperationRequest, senderId: number, dispatch: () => unknown, readOnly: boolean): Promise<AgentOperationResult> {
    if (![request.operationId, request.callId, request.turnId, request.toolName, request.channel].every(value => typeof value === 'string' && value.length > 0 && value.length <= 512) || !Array.isArray(request.args) || (request.scope !== undefined && typeof request.scope !== 'string') || (request.conversationId !== undefined && typeof request.conversationId !== 'string')) return { state: 'not_committed', error: '缺少或无效的操作身份' }
    const scope = normalizeScope(request.scope ?? '')
    const current = getCurrentProjectPath()
    if (scope && (!current || scope !== normalizeScope(current))) return { state: 'not_committed', error: '操作项目已切换' }
    let fingerprint: string
    try {
      fingerprint = hash(canonicalJson({ scope, callId: request.callId, turnId: request.turnId, conversationId: request.conversationId ?? null, tool: request.toolName, channel: request.channel, args: request.args }))
    } catch { return { state: 'not_committed', error: '无效的操作参数' } }
    const running = this.active.get(request.operationId)
    if (running) {
      if (running.fingerprint !== fingerprint || running.senderId !== senderId) return { state: 'not_committed', error: '操作ID参数冲突' }
      return running.promise
    }
    const cached = this.completed.get(request.operationId)
    if (cached) return cached.fingerprint === fingerprint ? cached.result : { state: 'not_committed', error: '操作ID参数冲突' }
    const existing = readOnly ? undefined : this.row(request.operationId)
    if (existing) {
      if (existing.fingerprint !== fingerprint) return { state: 'not_committed', error: '操作ID参数冲突' }
      if (existing.state === 'committed' || existing.state === 'not_committed') return { state: existing.state, value: existing.value_json ? JSON.parse(String(existing.value_json)) : undefined }
      return this.recover(existing)
    }
    const controller = new AbortController()
    const cancellationKey = `${senderId}:${request.callId}`
    const cancelledAt = this.cancelled.get(cancellationKey)
    if (cancelledAt !== undefined && Date.now() - cancelledAt <= 300_000) return { state: 'not_committed', error: '操作已取消' }
    if (cancelledAt !== undefined) this.cancelled.delete(cancellationKey)
    const target = request.channel === 'fs:write-file' ? normalizeScope(String(request.args[0]))
      : request.channel === 'db:draft-apply-content' ? `draft:${String((request.args[0] as { draftId?: unknown })?.draftId)}`
      : request.channel === 'db:character-upsert' || request.channel === 'db:character-create-missing' ? 'characters'
      : request.channel === 'project:update-config' ? 'config' : request.channel
    if (!readOnly) {
      try {
        const unresolved = this.db.prepare("SELECT * FROM agent_operations WHERE scope=? AND state IN ('running','unknown')").all(scope) as Record<string, unknown>[]
        const conflicts = unresolved.filter(row => row.target === target || (target === 'config' && String(row.target).startsWith('config:'))
          || (target === 'characters' && String(row.target).startsWith('character:')))
        for (const conflict of conflicts) {
          if (this.active.has(String(conflict.operation_id)) || this.recover(conflict).state === 'unknown') {
            return { state: 'not_committed', error: `同目标操作 ${String(conflict.operation_id)} 尚未核实，已阻止新写入` }
          }
        }
        this.db.prepare('INSERT INTO agent_operations (operation_id,call_id,turn_id,conversation_id,scope,tool_name,channel,fingerprint,target,content_hash,state,value_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
          request.operationId, request.callId, request.turnId, request.conversationId ?? null, scope,
          request.toolName, request.channel, fingerprint, target,
          request.channel === 'fs:write-file' ? hash(String(request.args[1])) : null, 'running', null, Date.now(),
        )
      } catch { return { state: 'not_committed', error: '执行意图保存失败，未调用工具' } }
    }
    const context: OperationContext = { request, fingerprint, signal: controller.signal, didCommit: false }
    const promise = Promise.resolve().then(() => storage.run(context, async (): Promise<AgentOperationResult> => {
      let started = false
      try {
        checkOperationCancellation()
        if (scope && normalizeScope(getCurrentProjectPath() ?? '') !== scope) throw new Error('操作项目已切换')
        started = true
        const value = await dispatch()
        const failed = value && typeof value === 'object' && (value as { success?: boolean }).success === false
        const state = context.didCommit ? 'committed' : failed ? 'unknown' : 'committed'
        if (!readOnly) {
          this.finish(request.operationId, state, value)
          this.completed.set(request.operationId, { fingerprint, result: { state, value } })
          if (this.completed.size > 1000) this.completed.delete(this.completed.keys().next().value!)
        }
        return { state, value }
      } catch (error) {
        const state = context.didCommit ? 'committed' : !started || (error instanceof Error && Boolean((error as Error & { [rollbackProof]?: boolean })[rollbackProof])) ? 'not_committed' : 'unknown'
        const failureValue = isOperationRollback(error) && error instanceof Error
          ? ('operationFailureValue' in error ? error.operationFailureValue : 'draftConflict' in error ? error.draftConflict : undefined)
          : undefined
        const value = context.didCommit ? context.value : failureValue
        try { if (!readOnly) this.finish(request.operationId, state, value) } catch { /* 下次从事务marker核对 */ }
        return { state, value, error: error instanceof Error ? error.message : '操作异常' }
      }
    })).finally(() => this.active.delete(request.operationId))
    this.active.set(request.operationId, { fingerprint, callId: request.callId, senderId, controller, promise })
    return promise
  }
  private recover(row: Record<string, unknown>): AgentOperationResult {
    if (normalizeScope(String(row.scope)) !== normalizeScope(getCurrentProjectPath() ?? '')) return { state: 'unknown', error: '操作项目未打开，未核实' }
    try {
      const projectDb = getProjectDb()
      if (projectDb) {
        projectDb.exec(MARKER_SCHEMA)
        const marker = projectDb.prepare('SELECT fingerprint,value_json FROM agent_operation_commits WHERE operation_id=?').get(row.operation_id) as { fingerprint: string; value_json: string } | undefined
        if (marker && marker.fingerprint === row.fingerprint) {
          const value = JSON.parse(marker.value_json)
          this.finish(String(row.operation_id), 'committed', value)
          return { state: 'committed', value }
        }
      }

    } catch { /* 核验失败保持未知，不重放 */ }
    return { state: 'unknown', error: '中断操作尚未核实，未重放' }
  }
  list(scope: string): AgentOperationRecord[] {
    const normalized = normalizeScope(scope)
    const rows = this.db.prepare('SELECT * FROM agent_operations WHERE scope=? ORDER BY updated_at').all(normalized) as Record<string, unknown>[]
    for (const row of rows) {
      if (row.state === 'unknown' && !this.active.has(String(row.operation_id))) {
        const result = this.recover(row)
        if (result.state === 'committed') { row.state = result.state; row.updated_at = Date.now() }
      }
    }
    return rows.map(row => ({
      operationId: String(row.operation_id), callId: String(row.call_id), turnId: String(row.turn_id),
      conversationId: row.conversation_id ? String(row.conversation_id) : undefined,
      scope: String(row.scope), toolName: String(row.tool_name), channel: String(row.channel), target: String(row.target),
      state: row.state as AgentOperationRecord['state'], updatedAt: Number(row.updated_at),
    }))
  }
  close(): void { this.db.close() }
}
let journal: AgentOperationJournal | undefined
export function getAgentOperationJournal(): AgentOperationJournal {
  if (!journal) {
    fs.mkdirSync(VELA_HOME, { recursive: true })
    const db = new Database(path.join(VELA_HOME, 'agent-operations.db'))
    db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL')
    journal = new AgentOperationJournal(db)
  }
  return journal
}
