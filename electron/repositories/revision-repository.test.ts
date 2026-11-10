import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { RevisionRepository } from './revision-repository'

const state = vi.hoisted(() => ({ db: undefined as unknown }))
vi.mock('../database', () => ({ getProjectDb: () => state.db }))
let db: DatabaseSync
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE contents (id INTEGER PRIMARY KEY, body TEXT);
    CREATE TABLE revisions (id INTEGER PRIMARY KEY, base_draft_id INTEGER, revision_index INTEGER,
      revision_type TEXT, status TEXT DEFAULT 'pending', merged_to_draft_id INTEGER,
      user_prompt TEXT, review_source_id INTEGER, content_id INTEGER, word_count INTEGER,
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
    ALTER TABLE revisions ADD COLUMN audit_report TEXT DEFAULT '';`)
  Object.assign(db, { transaction: (fn: () => unknown) => () => {
    db.exec('BEGIN')
    try { const value = fn(); db.exec('COMMIT'); return value } catch (error) { db.exec('ROLLBACK'); throw error }
  } })
  state.db = db
})
afterEach(() => db.close())

describe('修稿复查报告持久化', () => {
  it('升级旧表后候选正文和报告一起存储并可读取', () => {
    const auditReport = JSON.stringify({ checked: true, scope: 'revision_candidate' })
    const id = RevisionRepository.create({ baseDraftId: 3, revisionIndex: 1, revisionType: 'refine', content: '候选正文', wordCount: 4, auditReport })
    expect(RevisionRepository.getFull(id)).toMatchObject({ content: '候选正文', auditReport, baseDraftId: 3 })
    expect(RevisionRepository.listByDraft(3)[0].auditReport).toBe(auditReport)
  })
  it('兼容没有报告的旧调用', () => {
    const id = RevisionRepository.create({ baseDraftId: 3, revisionIndex: 1, revisionType: 'refine', content: '正文', wordCount: 2 })
    expect(RevisionRepository.getFull(id)?.auditReport).toBe('')
  })
})
