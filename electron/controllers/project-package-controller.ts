import { app, dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { guardedHandle } from '../security/ipc-guard'
import { withProjectTransferLock } from '../services/project-transfer-lock'
import { getCurrentProjectPath, getProjectDb, CURRENT_SCHEMA_VERSION } from '../database'
import { VELA_HOME, getProjectVelaDir } from '../utils/config-utils'
import { grantDirectory } from './fs-controller'
import { safeErrorMessage } from '../utils/error-utils'
import { t } from '../../src/shared/locale'
import { collectFiles, collectProjectSessions, inspectProjectDatabase, sealPackage, unpackPackage, prepareSessions, relocateDatabasePaths } from '../services/project-package'
import { safePackagePath } from '../services/project-package-zip'
import { getConnection, listDocuments, closeConnection, relocateDocumentPaths } from '../vector-store'

function safeName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100) || 'project'
}

export function registerProjectPackageController(): void {
  guardedHandle('project:export-package', async () => {
    try {
      const source = getCurrentProjectPath()
      if (!source || !getProjectDb()) throw new Error(t('package.noProject'))
      const selected = await dialog.showSaveDialog({ title: t('package.export'), defaultPath: `${safeName(path.basename(source))}.nfproject`, filters: [{ name: 'NovelForge Project', extensions: ['nfproject'] }] })
      if (selected.canceled || !selected.filePath) return { success: false, cancelled: true }
      const output = path.resolve(selected.filePath)
      const relative = path.relative(source, output)
      if (!relative.startsWith('..') && !path.isAbsolute(relative)) throw new Error(t('package.outsideProject'))
      return await withProjectTransferLock(async () => {
        if (getCurrentProjectPath() !== source) throw new Error(t('workflow.projectBusy'))
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'novelforge-package-'))
        const temporary = `${output}.${randomUUID()}.tmp`
        try {
          const internal = getProjectVelaDir(source)
          const internalDir = path.basename(internal) as '.novelforge' | '.vela'
          const exclusions = new Set([`${internalDir}/vela.db`, `${internalDir}/vela.db-wal`, `${internalDir}/vela.db-shm`])
          const files = await collectFiles(source, name => exclusions.has(name) || /(^|\/)(node_modules|\.git|logs|cache|credentials\.json|\.env)(\/|$)/i.test(name))
          const destination = path.join(root, 'project')
          for (const name of files) {
            const target = safePackagePath(destination, name)
            await fs.promises.mkdir(path.dirname(target), { recursive: true })
            await fs.promises.copyFile(safePackagePath(source, name), target)
          }
          const database = path.join(destination, internalDir, 'vela.db')
          await fs.promises.mkdir(path.dirname(database), { recursive: true })
          await getProjectDb()!.backup(database)
          const info = inspectProjectDatabase(database)
          const warnings: string[] = []
          const documents: Array<{ id: string; path: string | null }> = []
          if (fs.existsSync(path.join(internal, 'lancedb'))) {
            for (const doc of await listDocuments(source, true)) {
              if (!doc.filePath) continue
              let docPath: string | null = null
              if (fs.existsSync(doc.filePath)) {
                const sourceStat = await fs.promises.lstat(doc.filePath)
                if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error(`Unsupported knowledge source: ${doc.filePath}`)
                docPath = `${internalDir}/migration-sources/${randomUUID()}-${safeName(path.basename(doc.filePath))}`
                const target = safePackagePath(destination, docPath)
                await fs.promises.mkdir(path.dirname(target), { recursive: true })
                await fs.promises.copyFile(doc.filePath, target)
              } else warnings.push(t('package.missingSource').replace('{path}', doc.filePath))
              documents.push({ id: doc.id, path: docPath })
            }
          }
          await collectProjectSessions(VELA_HOME, source, path.join(root, 'sessions'))
          await sealPackage(root, {
            format: 'novelforge-project', version: 1, appVersion: app.getVersion(), schemaVersion: info.schemaVersion,
            projectName: info.name, sourcePath: source, internalDir, createdAt: new Date().toISOString(), documents, warnings,
          }, temporary)
          await fs.promises.rename(temporary, output)
          return { success: true, path: output, warnings }
        } finally {
          await fs.promises.rm(temporary, { force: true })
          await fs.promises.rm(root, { recursive: true, force: true })
        }
      })
    } catch (error) { return { success: false, error: safeErrorMessage(error) } }
  })

  guardedHandle('project:restore-package', async () => {
    try {
      const selected = await dialog.showOpenDialog({ title: t('package.restore'), properties: ['openFile'], filters: [{ name: 'NovelForge Project', extensions: ['nfproject'] }] })
      if (selected.canceled || !selected.filePaths[0]) return { success: false, cancelled: true }
      const directory = await dialog.showOpenDialog({ title: t('package.destination'), properties: ['openDirectory', 'createDirectory'] })
      if (directory.canceled || !directory.filePaths[0]) return { success: false, cancelled: true }
      const parent = directory.filePaths[0]
      return await withProjectTransferLock(async () => {
        const { root, manifest } = await unpackPackage(selected.filePaths[0], CURRENT_SCHEMA_VERSION)
        let staging: string
        try { staging = await fs.promises.mkdtemp(path.join(parent, '.novelforge-restore-')) }
        catch (error) { await fs.promises.rm(root, { recursive: true, force: true }); throw error }
        const installed: string[] = []
        let published = false
        const base = safeName(manifest.projectName)
        let finalPath = path.join(parent, base)
        for (let n = 1; fs.existsSync(finalPath); n++) finalPath = path.join(parent, `${base} (${n})`)
        try {
          await fs.promises.cp(path.join(root, 'project'), staging, { recursive: true, errorOnExist: true, force: false })
          const database = path.join(staging, manifest.internalDir, 'vela.db')
          relocateDatabasePaths(database, manifest.sourcePath, finalPath)
          if (fs.existsSync(path.join(staging, manifest.internalDir, 'lancedb'))) {
            try {
              const connection = await getConnection(staging)
              await connection.tableNames()
              await relocateDocumentPaths(staging, Object.fromEntries(manifest.documents.map(doc => [doc.id, doc.path ? safePackagePath(finalPath, doc.path) : ''])))
            } finally { await closeConnection(staging) }
          }
          const sessions = await prepareSessions(root, manifest, finalPath)
          const archiveDir = path.join(VELA_HOME, 'agent-archive')
          await fs.promises.mkdir(archiveDir, { recursive: true })
          for (const session of sessions) {
            const target = path.join(archiveDir, session.name)
            await fs.promises.writeFile(target, session.content, { flag: 'wx' })
            installed.push(target)
          }
          if (fs.existsSync(finalPath)) throw new Error('Restore destination already exists')
          await fs.promises.rename(staging, finalPath)
          published = true
          grantDirectory(finalPath)
          return { success: true, projectPath: finalPath, warnings: [...manifest.warnings, t('package.dependencies')] }
        } finally {
          if (!published) {
            for (const file of installed) await fs.promises.rm(file, { force: true })
            await fs.promises.rm(staging, { recursive: true, force: true })
          }
          await fs.promises.rm(root, { recursive: true, force: true })
        }
      })
    } catch (error) { return { success: false, error: safeErrorMessage(error) } }
  })
}
