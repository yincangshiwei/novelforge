import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'

interface ZipEntry { fileName: string; uncompressedSize: number; externalFileAttributes: number }
interface ZipReader {
  on(event: 'entry', listener: (entry: ZipEntry) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'end', listener: () => void): this
  readEntry(): void
  close(): void
  openReadStream(entry: ZipEntry, callback: (error: Error | null, stream?: Readable) => void): void
}
interface ZipWriter {
  outputStream: Readable
  addFile(source: string, name: string): void
  end(): void
}
interface Yauzl {
  open(file: string, options: { lazyEntries: boolean; autoClose: boolean; validateEntrySizes: boolean }, callback: (error: Error | null, zip?: ZipReader) => void): void
}

export function safePackagePath(root: string, name: string): string {
  const segments = name.split('/')
  if (!name || name.includes('\\') || segments.some(s => !s || s === '.' || s === '..' || /[<>:"|?*\x00-\x1f]/.test(s) || /[. ]$/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(s))) {
    throw new Error(`Invalid package path: ${name}`)
  }
  const target = path.resolve(root, ...segments)
  const relative = path.relative(root, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Invalid package path: ${name}`)
  return target
}

export async function writePackageZip(root: string, files: string[], output: string): Promise<void> {
  const yazl = require('yazl') as { ZipFile: new () => ZipWriter }
  const zip = new yazl.ZipFile()
  const done = pipeline(zip.outputStream, fs.createWriteStream(output, { flags: 'wx' }))
  try {
    for (const name of files) zip.addFile(safePackagePath(root, name), name)
    zip.end()
    await done
  } catch (error) {
    zip.outputStream.destroy(error as Error)
    await done.catch(() => {})
    throw error
  }
}

export async function extractPackageZip(file: string, root: string): Promise<void> {
  const yauzl = require('yauzl') as Yauzl
  const zip = await new Promise<ZipReader>((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (error, reader) => {
      if (error || !reader) reject(error ?? new Error('Invalid ZIP'))
      else resolve(reader)
    })
  })
  await new Promise<void>((resolve, reject) => {
    let total = 0
    const seen = new Set<string>()
    const fail = (error: unknown) => { zip.close(); reject(error) }
    zip.on('error', fail)
    zip.on('end', resolve)
    zip.on('entry', entry => {
      void (async () => {
        const name = entry.fileName
        const target = safePackagePath(root, name)
        const key = name.toLowerCase()
        const type = (entry.externalFileAttributes >>> 16) & 0o170000
        if ((type !== 0 && type !== 0o100000) || seen.has(key)) throw new Error(`Invalid or duplicate package entry: ${name}`)
        seen.add(key)
        total += entry.uncompressedSize
        if (seen.size > 100000 || !Number.isSafeInteger(total) || total > 20 * 1024 ** 3) throw new Error('Package exceeds extraction limits (20 GB / 100000 files)')
        if (name === 'manifest.json' && entry.uncompressedSize > 16 * 1024 ** 2) throw new Error('Manifest is too large')
        await fs.promises.mkdir(path.dirname(target), { recursive: true })
        const stream = await new Promise<Readable>((res, rej) => zip.openReadStream(entry, (error, value) => {
          if (error || !value) rej(error ?? new Error('Invalid entry'))
          else res(value)
        }))
        await pipeline(stream, fs.createWriteStream(target, { flags: 'wx' }))
        zip.readEntry()
      })().catch(fail)
    })
    zip.readEntry()
  })
}
