import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DraftRepository } from './draft-repository'
let db: DatabaseSync
vi.mock('../database', () => ({ getProjectDb: () => db }))
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE contents(id INTEGER PRIMARY KEY, body TEXT);
    CREATE TABLE drafts(id INTEGER PRIMARY KEY, chapter_number INTEGER, status TEXT, content_id INTEGER REFERENCES contents(id) ON DELETE RESTRICT);
    CREATE TABLE draft_snapshots(id INTEGER PRIMARY KEY, draft_id INTEGER REFERENCES drafts(id) ON DELETE CASCADE, content_id INTEGER REFERENCES contents(id) ON DELETE RESTRICT);
    CREATE TABLE revisions(id INTEGER PRIMARY KEY, base_draft_id INTEGER REFERENCES drafts(id) ON DELETE CASCADE, merged_to_draft_id INTEGER, content_id INTEGER REFERENCES contents(id) ON DELETE RESTRICT);
    CREATE TABLE reviews(id INTEGER PRIMARY KEY, base_draft_id INTEGER REFERENCES drafts(id) ON DELETE CASCADE, content_id INTEGER REFERENCES contents(id) ON DELETE RESTRICT);
    CREATE TABLE draft_branches(id INTEGER PRIMARY KEY, head_draft_id INTEGER, base_snapshot_id INTEGER);
    CREATE TABLE scenes(id INTEGER PRIMARY KEY, content_id INTEGER);
    INSERT INTO contents VALUES(1,'draft'),(2,'snapshot'),(3,'revision'),(4,'review');
    INSERT INTO drafts VALUES(1,3,'archived',1);
    INSERT INTO draft_snapshots VALUES(1,1,2);
    INSERT INTO revisions VALUES(1,1,NULL,3);
    INSERT INTO reviews VALUES(1,1,4);`)
  Object.assign(db, { transaction: (fn: () => void) => () => {
    db.exec('BEGIN')
    try { fn(); db.exec('COMMIT') } catch (error) { db.exec('ROLLBACK'); throw error }
  } })
})
afterEach(() => db.close())
describe('归档草稿永久删除', () => {
  it('删除草稿及派生记录和无引用正文', () => {
    DraftRepository.deleteArchived(1, 3)
    expect(db.prepare('SELECT * FROM drafts').all()).toEqual([])
    expect(db.prepare('SELECT * FROM draft_snapshots').all()).toEqual([])
    expect(db.prepare('SELECT * FROM contents').all()).toEqual([])
  })
  it('共享正文保留，其他草稿不删除', () => {
    db.exec("INSERT INTO drafts VALUES(2,3,'draft',1)")
    DraftRepository.deleteArchived(1, 3)
    expect(db.prepare('SELECT id FROM contents').all()).toEqual([{ id: 1 }])
    expect(db.prepare('SELECT id FROM drafts').all()).toEqual([{ id: 2 }])
  })
  it.each([0, -1, 1.5])('拒绝非法ID %s', id => {
    expect(() => DraftRepository.deleteArchived(id, 3)).toThrow()
  })
  it('定稿/章节不匹配不得删除', () => {
    expect(() => DraftRepository.deleteArchived(1, 4)).toThrow()
    db.exec("UPDATE drafts SET status='finalized'")
    expect(() => DraftRepository.deleteArchived(1, 3)).toThrow()
    expect(db.prepare('SELECT id FROM contents').all()).toHaveLength(4)
  })
  it('分支基线引用拒绝删除，事务不丢记录', () => {
    db.exec('INSERT INTO draft_branches VALUES(1,NULL,1)')
    expect(() => DraftRepository.deleteArchived(1, 3)).toThrow('引用')
    expect(db.prepare('SELECT id FROM drafts').all()).toHaveLength(1)
    expect(db.prepare('SELECT id FROM contents').all()).toHaveLength(4)
  })
})
