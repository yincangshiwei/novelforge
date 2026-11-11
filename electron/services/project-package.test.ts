import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { collectProjectSessions, hashFile, inspectProjectDatabase, prepareSessions, relocateDatabasePaths, remapStructuredPaths, sealPackage, unpackPackage, validatePackage } from './project-package'
import { extractPackageZip, safePackagePath, writePackageZip } from './project-package-zip'
import { enterProjectCall, isProjectTransferLocked, withProjectTransferLock } from './project-transfer-lock'
import type { PackageManifest } from './project-package'

let root: string
beforeEach(async () => { root = await fs.promises.mkdtemp(path.join(process.cwd(), '.transfer-test-')) })
afterEach(async () => { await fs.promises.rm(root, { recursive: true, force: true }) })

const manifest = (): Omit<PackageManifest, 'files'> => ({
  format: 'novelforge-project', version: 1, appVersion: '0.1.7', schemaVersion: 24,
  projectName: '迁移测试', sourcePath: 'C:\\books\\novel', internalDir: '.novelforge',
  createdAt: new Date().toISOString(), documents: [], warnings: [],
})
async function put(name: string, text: string): Promise<string> {
  const target = path.join(root, name)
  await fs.promises.mkdir(path.dirname(target), { recursive: true })
  await fs.promises.writeFile(target, text)
  return target
}

describe('项目迁移实际文件验证', () => {
  it('流式 ZIP 往返保留中文文件名、隐藏目录和二进制内容', async () => {
    const source = await put('source/.novelforge/prompts/测试.txt', '提示词\n你好')
    await put('source/章节/第一章.md', '# 第一章\n正文')
    await fs.promises.writeFile(path.join(root, 'source', 'binary.bin'), Buffer.from([0, 255, 17, 128]))
    const zip = path.join(root, 'project.nfproject')
    const names = ['.novelforge/prompts/测试.txt', '章节/第一章.md', 'binary.bin']
    await writePackageZip(path.join(root, 'source'), names, zip)
    await extractPackageZip(zip, path.join(root, 'restored'))
    expect(await hashFile(source)).toBe(await hashFile(path.join(root, 'restored', names[0])))
    expect(await fs.promises.readFile(path.join(root, 'restored', 'binary.bin'))).toEqual(Buffer.from([0, 255, 17, 128]))
  })

  it.each(['../escape', '/absolute', 'C:/escape', 'a\\b', 'a/../../b', 'a/CON.txt', 'a/file.', 'a/file '])('拒绝非法包路径 %s', name => {
    expect(() => safePackagePath(root, name)).toThrow()
  })

  it('拒绝大小写冲突的 ZIP 条目', async () => {
    await put('source/A.txt', 'one')
    const zip = path.join(root, 'duplicate.zip')
    await writePackageZip(path.join(root, 'source'), ['A.txt', 'A.txt'], zip)
    await expect(extractPackageZip(zip, path.join(root, 'restored'))).rejects.toThrow('duplicate')
  })

  it('清单校验拦截篡改内容和未声明文件', async () => {
    await put('payload/project/.novelforge/vela.db', 'database fixture')
    await sealPackage(path.join(root, 'payload'), manifest(), path.join(root, 'package.zip'))
    const target = path.join(root, 'unpacked')
    await extractPackageZip(path.join(root, 'package.zip'), target)
    await expect(validatePackage(target)).resolves.toMatchObject({ projectName: '迁移测试' })
    await fs.promises.writeFile(path.join(target, 'extra.txt'), 'unexpected')
    await expect(validatePackage(target)).rejects.toThrow('undeclared')
    await fs.promises.unlink(path.join(target, 'extra.txt'))
    await fs.promises.writeFile(path.join(target, 'project/.novelforge/vela.db'), 'tampered')
    await expect(validatePackage(target)).rejects.toThrow('checksum')
  })

  it('收集项目会话及压缩原文，恢复时改 ID 和路径，不修改旧归档', async () => {
    const source = path.join(root, 'novel')
    await put('home/agent-archive/first.json', JSON.stringify({ id: 'first', projectPath: source, messages: [] }))
    await put('home/agent-archive/first.originals.json', JSON.stringify({ batches: ['原文'] }))
    await put('home/agent-archive/second.json', JSON.stringify({ id: 'second', parentId: 'first', projectPath: source, messages: [] }))
    await put('home/agent-archive/other.json', JSON.stringify({ id: 'other', projectPath: path.join(root, 'other') }))
    await collectProjectSessions(path.join(root, 'home'), source, path.join(root, 'payload/sessions'))
    const data = { ...manifest(), sourcePath: source, files: [] }
    const newPath = path.join(root, 'new-computer/novel')
    const sessions = await prepareSessions(path.join(root, 'payload'), data, newPath)
    expect(sessions).toHaveLength(3)
    const archives = sessions.filter(s => !s.name.endsWith('.originals.json')).map(s => JSON.parse(s.content))
    expect(archives.every(a => a.projectPath === newPath && !['first', 'second'].includes(a.id))).toBe(true)
    const child = archives.find(a => a.parentId)
    expect(archives.some(a => a.id === child.parentId)).toBe(true)
    expect(JSON.parse(await fs.promises.readFile(path.join(root, 'home/agent-archive/first.json'), 'utf-8')).id).toBe('first')
  })

  it('结构化路径迁移保留无关路径和正文', () => {
    expect(remapStructuredPaths({ file: 'c:\\books\\novel\\chapter.txt', other: 'C:\\books\\novel2\\file', text: '正文 C:\\books\\novel' }, 'C:\\books\\novel', root)).toEqual({
      file: path.join(root, 'chapter.txt'), other: 'C:\\books\\novel2\\file', text: '正文 C:\\books\\novel',
    })
  })

  it('迁移锁拒绝并发调用，完成或失败后释放', async () => {
    await withProjectTransferLock(async () => {
      expect(isProjectTransferLocked()).toBe(true)
      expect(() => enterProjectCall()).toThrow()
    })
    expect(isProjectTransferLocked()).toBe(false)
    const a = enterProjectCall()
    const b = enterProjectCall()
    try { await expect(withProjectTransferLock(async () => true)).rejects.toThrow('busy') }
    finally { a(); b() }
    await expect(withProjectTransferLock(async () => { throw new Error('test failure') })).rejects.toThrow('test failure')
    expect(isProjectTransferLocked()).toBe(false)
  })

  it('真实 WAL 快照打包恢复，并拒绝高版本库', async () => {
    const file = path.join(root, 'source.db')
    const db = new Database(file)
    let unpacked: string | undefined
    try {
      db.pragma('journal_mode = WAL')
      db.exec("CREATE TABLE project_core (project_name TEXT); INSERT INTO project_core VALUES ('迁移测试'); CREATE TABLE checkpoint (scope TEXT, data TEXT); PRAGMA user_version = 24")
      db.prepare('INSERT INTO checkpoint VALUES (?, ?)').run(manifest().sourcePath, JSON.stringify({ projectPath: manifest().sourcePath }))
      const payload = path.join(root, 'payload')
      const snapshot = path.join(payload, 'project/.novelforge/vela.db')
      await fs.promises.mkdir(path.dirname(snapshot), { recursive: true })
      await db.backup(snapshot)
      await sealPackage(payload, manifest(), path.join(root, 'package.nfproject'))
      const result = await unpackPackage(path.join(root, 'package.nfproject'), 24)
      unpacked = result.root
      const restored = path.join(result.root, 'project/.novelforge/vela.db')
      expect(inspectProjectDatabase(restored, 24).name).toBe('迁移测试')
      expect(() => inspectProjectDatabase(restored, 23)).toThrow('newer')
      relocateDatabasePaths(restored, manifest().sourcePath, root)
      const read = new Database(restored, { readonly: true })
      try {
        const row = read.prepare('SELECT * FROM checkpoint').get() as { scope: string; data: string }
        expect(row.scope).toBe(root)
        expect(JSON.parse(row.data).projectPath).toBe(root)
      } finally { read.close() }
    } finally {
      db.close()
      if (unpacked) await fs.promises.rm(unpacked, { recursive: true, force: true })
    }
  })
})
