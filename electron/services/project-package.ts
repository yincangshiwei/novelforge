import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { safePackagePath, writePackageZip, extractPackageZip } from './project-package-zip'

export interface PackageManifest {
  format: 'novelforge-project'
  version: 1
  appVersion: string
  schemaVersion: number
  projectName: string
  sourcePath: string
  internalDir: '.novelforge' | '.vela'
  createdAt: string
  files: Array<{ path: string; size: number; sha256: string }>
  documents: Array<{ id: string; path: string | null }>
  warnings: string[]
}

export async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export async function collectFiles(root: string, exclude: (name: string) => boolean = () => false): Promise<string[]> {
  const files: string[] = []
  async function visit(dir: string, prefix: string): Promise<void> {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      if (exclude(name)) continue
      const target = safePackagePath(root, name)
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links cannot be migrated: ${name}`)
      if (entry.isDirectory()) await visit(target, name)
      else if (entry.isFile()) files.push(name)
      else throw new Error(`Unsupported project file: ${name}`)
    }
  }
  await visit(root, '')
  return files.sort()
}

export function inspectProjectDatabase(file: string, supportedVersion?: number): { schemaVersion: number; name: string } {
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Project database integrity check failed')
    const schemaVersion = db.pragma('user_version', { simple: true }) as number
    if (supportedVersion !== undefined && schemaVersion > supportedVersion) throw new Error('This project requires a newer version of NovelForge')
    const core = db.prepare('SELECT project_name FROM project_core LIMIT 1').get() as { project_name: string } | undefined
    if (!core) throw new Error('Missing project configuration')
    return { schemaVersion, name: core.project_name }
  } finally { db.close() }
}

export async function sealPackage(root: string, manifest: Omit<PackageManifest, 'files'>, output: string): Promise<void> {
  const files = await collectFiles(root)
  const records: PackageManifest['files'] = []
  for (const name of files) {
    const file = safePackagePath(root, name)
    records.push({ path: name, size: (await fs.promises.stat(file)).size, sha256: await hashFile(file) })
  }
  await fs.promises.writeFile(path.join(root, 'manifest.json'), JSON.stringify({ ...manifest, files: records }), { flag: 'wx' })
  await writePackageZip(root, [...files, 'manifest.json'], output)
}

export async function validatePackage(root: string): Promise<PackageManifest> {
  const manifest = JSON.parse(await fs.promises.readFile(path.join(root, 'manifest.json'), 'utf-8')) as PackageManifest
  if (manifest.format !== 'novelforge-project' || manifest.version !== 1 || !['.novelforge', '.vela'].includes(manifest.internalDir)
    || typeof manifest.projectName !== 'string' || typeof manifest.sourcePath !== 'string' || !Number.isInteger(manifest.schemaVersion)
    || !Array.isArray(manifest.files) || !Array.isArray(manifest.documents) || !Array.isArray(manifest.warnings)
    || manifest.warnings.some(w => typeof w !== 'string')) throw new Error('Unsupported or invalid project package')
  const expected = new Set<string>(['manifest.json'])
  for (const record of manifest.files) {
    if (typeof record.path !== 'string' || (!record.path.startsWith('project/') && !record.path.startsWith('sessions/'))
      || expected.has(record.path) || !Number.isSafeInteger(record.size) || record.size < 0 || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error('Invalid package manifest')
    expected.add(record.path)
    const file = safePackagePath(root, record.path)
    if ((await fs.promises.stat(file)).size !== record.size || await hashFile(file) !== record.sha256) throw new Error(`Package checksum failed: ${record.path}`)
  }
  const actual = await collectFiles(root)
  if (actual.length !== expected.size || actual.some(name => !expected.has(name))) throw new Error('Package contains undeclared files')
  const ids = new Set<string>()
  for (const doc of manifest.documents) {
    if (typeof doc.id !== 'string' || ids.has(doc.id) || (doc.path !== null && (typeof doc.path !== 'string' || !expected.has(`project/${doc.path}`)))) throw new Error('Invalid document mapping')
    ids.add(doc.id)
    if (doc.path) safePackagePath(path.join(root, 'project'), doc.path)
  }
  if (!expected.has(`project/${manifest.internalDir}/vela.db`)) throw new Error('Package has no project database')
  return manifest
}

export async function unpackPackage(file: string, supportedVersion: number): Promise<{ root: string; manifest: PackageManifest }> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'novelforge-restore-'))
  try {
    await extractPackageZip(file, root)
    const manifest = await validatePackage(root)
    const info = inspectProjectDatabase(path.join(root, 'project', manifest.internalDir, 'vela.db'), supportedVersion)
    if (info.schemaVersion !== manifest.schemaVersion) throw new Error('Database version does not match manifest')
    return { root, manifest }
  } catch (error) {
    await fs.promises.rm(root, { recursive: true, force: true })
    throw error
  }
}

export function remapStructuredPaths(value: unknown, oldRoot: string, newRoot: string, ids: Record<string, string> = {}): unknown {
  if (typeof value === 'string') {
    if (ids[value]) return ids[value]
    const normalized = value.replace(/\\/g, '/')
    const old = oldRoot.replace(/\\/g, '/').replace(/\/$/, '')
    const matches = /^[a-z]:/i.test(old) ? normalized.toLowerCase() === old.toLowerCase() || normalized.toLowerCase().startsWith(`${old.toLowerCase()}/`) : normalized === old || normalized.startsWith(`${old}/`)
    if (matches) return path.join(newRoot, ...normalized.slice(old.length).split('/').filter(Boolean))
    return value
  }
  if (Array.isArray(value)) return value.map(v => remapStructuredPaths(v, oldRoot, newRoot, ids))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remapStructuredPaths(v, oldRoot, newRoot, ids)]))
  return value
}

export async function collectProjectSessions(home: string, projectPath: string, destination: string): Promise<void> {
  const archiveDir = path.join(home, 'agent-archive')
  if (!fs.existsSync(archiveDir)) return
  for (const name of await fs.promises.readdir(archiveDir)) {
    if (!/^[a-zA-Z0-9_-]+\.json$/.test(name)) continue
    const source = path.join(archiveDir, name)
    const data = JSON.parse(await fs.promises.readFile(source, 'utf-8')) as { projectPath?: string }
    if (!data.projectPath || path.resolve(data.projectPath).toLowerCase() !== path.resolve(projectPath).toLowerCase()) continue
    await fs.promises.mkdir(destination, { recursive: true })
    await fs.promises.copyFile(source, path.join(destination, name))
    const originals = name.replace(/\.json$/, '.originals.json')
    if (fs.existsSync(path.join(archiveDir, originals))) await fs.promises.copyFile(path.join(archiveDir, originals), path.join(destination, originals))
  }
}

export async function prepareSessions(root: string, manifest: PackageManifest, finalPath: string): Promise<Array<{ name: string; content: string }>> {
  const dir = path.join(root, 'sessions')
  if (!fs.existsSync(dir)) return []
  const names = await fs.promises.readdir(dir)
  const ids: Record<string, string> = {}
  for (const name of names) {
    if (!/^[a-zA-Z0-9_-]+(?:\.originals)?\.json$/.test(name)) throw new Error('Invalid session filename')
    if (!name.endsWith('.originals.json')) ids[name.slice(0, -5)] = randomUUID()
  }
  const files: Array<{ name: string; content: string }> = []
  for (const name of names) {
    const original = name.endsWith('.originals.json')
    const oldId = name.slice(0, original ? -15 : -5)
    if (!ids[oldId]) throw new Error('Orphan session originals')
    const raw = JSON.parse(await fs.promises.readFile(path.join(dir, name), 'utf-8')) as Record<string, unknown>
    const data = remapStructuredPaths(raw, manifest.sourcePath, finalPath, ids) as Record<string, unknown>
    if (!original) {
      data.id = ids[oldId]
      data.projectPath = finalPath
    }
    files.push({ name: `${ids[oldId]}${original ? '.originals' : ''}.json`, content: JSON.stringify(data) })
  }
  return files
}

export function relocateDatabasePaths(file: string, oldRoot: string, newRoot: string): void {
  const db = new Database(file)
  try {
    const quote = (name: string) => `"${name.replace(/"/g, '""')}"`
    db.transaction(() => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>
      for (const { name } of tables) {
        if (name.includes('fts')) continue
        const columns = db.pragma(`table_info(${quote(name)})`) as Array<{ name: string; type: string }>
        let offset = 0
        const select = db.prepare(`SELECT rowid AS __transfer_rowid, * FROM ${quote(name)} ORDER BY rowid LIMIT 100 OFFSET ?`)
        while (true) {
          const rows = select.all(offset) as Record<string, unknown>[]
          if (!rows.length) break
          for (const row of rows) {
            for (const column of columns) {
              const text = row[column.name]
              if (typeof text !== 'string') continue
              let updated: unknown = text
              if (column.name.toLowerCase().includes('path') || column.name === 'scope') updated = remapStructuredPaths(text, oldRoot, newRoot)
              else if (/^[\[{]/.test(text.trim())) {
                try { updated = JSON.stringify(remapStructuredPaths(JSON.parse(text), oldRoot, newRoot)) } catch { continue }
              }
              if (updated !== text) db.prepare(`UPDATE ${quote(name)} SET ${quote(column.name)} = ? WHERE rowid = ?`).run(updated, row.__transfer_rowid)
            }
          }
          offset += rows.length
        }
      }
    })()
    db.pragma('wal_checkpoint(TRUNCATE)')
  } finally { db.close() }
}
