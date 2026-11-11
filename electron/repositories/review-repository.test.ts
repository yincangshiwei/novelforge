import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReviewRepository } from './review-repository'

const state = vi.hoisted(() => ({ db: undefined as unknown }))
vi.mock('../database', () => ({ getProjectDb: () => state.db }))
let db: DatabaseSync
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE contents (id INTEGER PRIMARY KEY, body TEXT);
    CREATE TABLE drafts (id INTEGER PRIMARY KEY, content_id INTEGER REFERENCES contents(id));
    CREATE TABLE draft_snapshots (id INTEGER PRIMARY KEY, content_id INTEGER REFERENCES contents(id));
    CREATE TABLE scene_cards (id INTEGER PRIMARY KEY, content_id INTEGER);
    CREATE TABLE revisions (id INTEGER PRIMARY KEY, review_source_id INTEGER, content_id INTEGER REFERENCES contents(id));
    CREATE TABLE reviews (id INTEGER PRIMARY KEY, base_draft_id INTEGER REFERENCES drafts(id), review_index INTEGER,
      content_id INTEGER REFERENCES contents(id) ON DELETE RESTRICT, created_at INTEGER DEFAULT 0);
    INSERT INTO contents VALUES (1, '正文'), (2, '报告一'), (3, '报告二');
    INSERT INTO drafts VALUES (42, 1);
    INSERT INTO reviews VALUES (11, 42, 1, 2, 1), (12, 42, 2, 3, 2);
    INSERT INTO revisions VALUES (5, 12, 1);`)
  Object.assign(db, { transaction: (fn: () => unknown) => () => {
    db.exec('BEGIN')
    try { const result = fn(); db.exec('COMMIT'); return result } catch (e) { db.exec('ROLLBACK'); throw e }
  } })
  state.db = db
})
afterEach(() => db.close())

describe('审稿报告历史与删除', () => {
  it('删除最新报告后历史和最新查询回退，保留正文及修稿并解除引用', () => {
    ReviewRepository.delete(12)
    expect(ReviewRepository.listByDraft(42).map(r => r.id)).toEqual([11])
    expect(ReviewRepository.getLatestByDraft(42)?.content).toBe('报告一')
    expect(db.prepare('SELECT * FROM contents WHERE id = 3').get()).toBeUndefined()
    expect(db.prepare('SELECT * FROM drafts WHERE id = 42').get()).toBeTruthy()
    expect(db.prepare('SELECT review_source_id FROM revisions WHERE id = 5').get()?.review_source_id).toBeNull()
  })
  it('共享内容仍被引用时不能清理', () => {
    db.prepare('INSERT INTO scene_cards VALUES (1, 3)').run()
    ReviewRepository.delete(12)
    expect(db.prepare('SELECT body FROM contents WHERE id = 3').get()?.body).toBe('报告二')
  })
  it('删除失败回滚报告、正文和修稿引用', () => {
    db.exec("CREATE TRIGGER fail_cleanup BEFORE DELETE ON contents BEGIN SELECT RAISE(ABORT, '失败'); END;")
    expect(() => ReviewRepository.delete(12)).toThrow('失败')
    expect(ReviewRepository.getFull(12)?.content).toBe('报告二')
    expect(db.prepare('SELECT review_source_id FROM revisions WHERE id = 5').get()?.review_source_id).toBe(12)
  })
  it('可删除最后一份报告，拒绝无效ID和重复删除', () => {
    ReviewRepository.delete(12)
    ReviewRepository.delete(11)
    expect(ReviewRepository.listByDraft(42)).toEqual([])
    expect(ReviewRepository.getLatestByDraft(42)).toBeNull()
    expect(() => ReviewRepository.delete(11)).toThrow('不存在')
    expect(() => ReviewRepository.delete(NaN)).toThrow('无效')
  })
})
