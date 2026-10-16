/**
 * The application copy: the archive manifest is renamed in place at the same length,
 * every other byte survives, and archive backups are left behind.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { APP_COPY_SCRIPT } from '../src/app-copy.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/**
 * Write an archive in the asar layout: an 8-byte size pickle, a header pickle holding the
 * JSON index, then the file bodies at their recorded offsets.
 */
function writeArchive(path: string, files: Record<string, string>): void {
  const bodies: Buffer[] = []
  const index: Record<string, { size: number; offset: string }> = {}
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content, 'utf8')
    index[name] = { size: body.length, offset: String(offset) }
    bodies.push(body)
    offset += body.length
  }
  const json = Buffer.from(JSON.stringify({ files: index }), 'utf8')
  const padded = Math.ceil(json.length / 4) * 4
  const header = Buffer.alloc(8 + padded)
  header.writeUInt32LE(4 + padded, 0)
  header.writeUInt32LE(json.length, 4)
  json.copy(header, 8)
  const size = Buffer.alloc(8)
  size.writeUInt32LE(4, 0)
  size.writeUInt32LE(header.length, 4)
  writeFileSync(path, Buffer.concat([size, header, ...bodies]))
}

it('copies the app, renames its manifest at the same length, and leaves backups out', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-app-copy-'))
  roots.push(root)
  const source = join(root, 'installed')
  mkdirSync(join(source, 'resources', 'runtime'), { recursive: true })
  writeFileSync(join(source, 'App.exe'), 'binary')
  writeFileSync(join(source, 'resources', 'runtime', 'node.txt'), 'runtime')
  writeFileSync(join(source, 'resources', 'app.asar.orig-1'), 'backup')
  const manifest = '{\n  "name": "@deepseek-ai/dsh-desktop",\n  "main": "lib/main.js"\n}'
  writeArchive(join(source, 'resources', 'app.asar'), { 'lib.js': 'console.log(1)', 'package.json': manifest })

  const target = join(root, 'copy')
  const run = spawnSync(process.execPath, ['-e', APP_COPY_SCRIPT], {
    env: { ...process.env, DSH_APP_COPY_ARGS: JSON.stringify({ source, target, exclude: ['app.asar.orig'] }) },
    encoding: 'utf8',
  })
  expect(run.status, run.stderr).toBe(0)
  expect(JSON.parse(run.stdout.trim())).toEqual({ name: '@deepseek-ai/dsh-desktox', original: '@deepseek-ai/dsh-desktop', changed: true })

  const before = readFileSync(join(source, 'resources', 'app.asar'))
  const after = readFileSync(join(target, 'resources', 'app.asar'))
  expect(after.length).toBe(before.length)
  expect(after.toString('utf8')).toContain('"name": "@deepseek-ai/dsh-desktox"')
  expect(after.toString('utf8')).toContain('console.log(1)')
  // The installed archive is untouched.
  expect(before.toString('utf8')).toContain('"name": "@deepseek-ai/dsh-desktop"')
  expect(readFileSync(join(target, 'resources', 'runtime', 'node.txt'), 'utf8')).toBe('runtime')
  expect(existsSync(join(target, 'resources', 'app.asar.orig-1'))).toBe(false)
})

it('fails loudly when the archive has no manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-app-copy-'))
  roots.push(root)
  const source = join(root, 'installed')
  mkdirSync(join(source, 'resources'), { recursive: true })
  writeArchive(join(source, 'resources', 'app.asar'), { 'lib.js': 'x' })
  const run = spawnSync(process.execPath, ['-e', APP_COPY_SCRIPT], {
    env: { ...process.env, DSH_APP_COPY_ARGS: JSON.stringify({ source, target: join(root, 'copy'), exclude: [] }) },
    encoding: 'utf8',
  })
  expect(run.status).not.toBe(0)
  expect(run.stderr).toContain('app.asar has no package.json')
})

it('only renames when asked, restoring the test name to a swapped archive and leaving a renamed one alone', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-app-copy-'))
  roots.push(root)
  const target = join(root, 'copy')
  mkdirSync(join(target, 'resources'), { recursive: true })
  writeFileSync(join(target, 'keep.txt'), 'untouched')
  const archive = join(target, 'resources', 'app.asar')
  // A patched archive swapped in by hand carries the installed name again.
  writeArchive(archive, { 'package.json': '{"name":"@deepseek-ai/dsh-desktop"}' })
  const runRename = () => spawnSync(process.execPath, ['-e', APP_COPY_SCRIPT], {
    env: { ...process.env, DSH_APP_COPY_ARGS: JSON.stringify({ source: join(root, 'none'), target, exclude: [], renameOnly: true, installedName: '@deepseek-ai/dsh-desktop' }) },
    encoding: 'utf8',
  })
  const first = runRename()
  expect(JSON.parse(first.stdout.trim())).toEqual({ name: '@deepseek-ai/dsh-desktox', original: '@deepseek-ai/dsh-desktop', changed: true })
  expect(readFileSync(archive, 'utf8')).toContain('"@deepseek-ai/dsh-desktox"')
  expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('untouched')
  const second = runRename()
  expect((JSON.parse(second.stdout.trim()) as { changed: boolean }).changed).toBe(false)
})
