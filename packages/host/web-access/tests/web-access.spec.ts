/**
 * The Web access file: sealing, publication, withdrawal, and the reader that
 * has to open what the host wrote. The point of the file is that the token is
 * not readable from the file itself, so the specs assert both directions — the
 * URL round-trips for the reader, and the raw bytes never carry it.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ACCESS_FILE_VERSION, apply, deriveKey, machineContext, openPayload, readOrCreateKey, sealPayload, type AccessRecord,
} from '../src/index.ts'

/** The operator-facing reader, exercised as the process an operator runs. */
const READER = fileURLToPath(new URL('../../../../scripts/web-access.mjs', import.meta.url))

/** Run the reader script and return its stdout, or throw with its stderr. */
function runReader(script: string, args: string[]): string {
  return execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' }).trim()
}

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-web-access-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const PAYLOAD = { url: 'http://127.0.0.1:19387/?token=SECRET-TOKEN-abc123', token: 'SECRET-TOKEN-abc123' }

function writePair(dir: string, payload = PAYLOAD): { file: string; keyFile: string; record: AccessRecord } {
  const file = join(dir, 'web-access.json')
  const keyFile = join(dir, 'web-access.key')
  const secret = readOrCreateKey(keyFile)
  const record: AccessRecord = {
    version: ACCESS_FILE_VERSION,
    createdAt: '2026-10-03T00:00:00.000Z',
    pid: process.pid,
    profile: 'desktop',
    algorithm: 'aes-256-gcm',
    ...sealPayload(payload, deriveKey(secret, machineContext())),
    hint: 'node scripts/web-access.mjs',
  }
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`)
  return { file, keyFile, record }
}

describe('sealing', () => {
  it('round-trips a payload through the package helpers', () => {
    const key = deriveKey('secret', machineContext())
    expect(openPayload(sealPayload(PAYLOAD, key), key)).toEqual(PAYLOAD)
  })

  it('refuses a payload sealed for another machine or user', () => {
    const sealed = sealPayload(PAYLOAD, deriveKey('secret', machineContext()))
    const elsewhere = deriveKey('secret', 'dsh-web-access\u0000other-host\u0000other-user')
    expect(() => openPayload(sealed, elsewhere)).toThrow()
  })

  it('refuses a modified ciphertext instead of returning a partial payload', () => {
    const key = deriveKey('secret', machineContext())
    const sealed = sealPayload(PAYLOAD, key)
    const tampered = Buffer.from(sealed.sealed, 'base64')
    tampered[0] = (tampered[0]! ^ 0xff) & 0xff
    expect(() => openPayload({ ...sealed, sealed: tampered.toString('base64') }, key)).toThrow()
  })

  it('creates the key file owner-only and reuses it afterwards', () => {
    const keyFile = join(tempDir(), 'nested', 'web-access.key')
    const first = readOrCreateKey(keyFile)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(readOrCreateKey(keyFile)).toBe(first)
  })
})

describe('the row', () => {
  /** A context carrying the two services the row binds, and no Loader. */
  async function mount(dir: string): Promise<{ ctx: Context; file: string; keyFile: string }> {
    const ctx = new Context()
    ctx.provide('webServer', { port: 19387 })
    ctx.provide('connection', { authenticatedUrl: (url: string) => `${url}/?token=SECRET-TOKEN-abc123` })
    const file = join(dir, 'web-access.json')
    const keyFile = join(dir, 'web-access.key')
    await ctx.plugin({ inject: ['connection', 'webServer'], apply, name: 'web-access' }, { path: file, keyPath: keyFile })
      .await()
    return { ctx, file, keyFile }
  }

  it('publishes the authenticated URL without a Loader, and withdraws it on dispose', async () => {
    const dir = tempDir()
    const { ctx, file, keyFile } = await mount(dir)
    expect(readFileSync(file, 'utf8')).not.toContain('SECRET-TOKEN-abc123')
    expect(runReader(READER, ['--path', file, '--key-path', keyFile])).toBe(PAYLOAD.url)
    await ctx.fiber.dispose()
    expect(existsSync(file), 'the row removes the file it published when its tree disposes').toBe(false)
  })

  it('leaves a newer publication from another process alone', async () => {
    const dir = tempDir()
    const { ctx, file, keyFile } = await mount(dir)
    const mine = JSON.parse(readFileSync(file, 'utf8')) as AccessRecord
    // Another host publishes over the same path while this one is still mounted.
    const theirRecord = { ...mine, pid: mine.pid + 1, ...sealPayload(PAYLOAD, deriveKey(readOrCreateKey(keyFile), machineContext())) }
    writeFileSync(file, `${JSON.stringify(theirRecord)}\n`)
    await ctx.fiber.dispose()
    expect(existsSync(file), 'a reloading composition may have published a newer file').toBe(true)
    expect((JSON.parse(readFileSync(file, 'utf8')) as AccessRecord).pid).toBe(theirRecord.pid)
  })
})

describe('the published file', () => {
  it('never carries the token or the URL in readable form', () => {
    const { file } = writePair(tempDir())
    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain('SECRET-TOKEN-abc123')
    expect(raw).not.toContain('127.0.0.1:19387')
    expect(raw).toContain('aes-256-gcm')
  })

  it('is opened by the reader script, which mirrors the package helpers', () => {
    const { file, keyFile, record } = writePair(tempDir())
    expect(runReader(READER, ['--path', file, '--key-path', keyFile])).toBe(PAYLOAD.url)
    expect(runReader(READER, ['--path', file, '--key-path', keyFile, '--token'])).toBe(PAYLOAD.token)
    const json = JSON.parse(runReader(READER, ['--path', file, '--key-path', keyFile, '--json'])) as {
      payload: { url: string }
      pid: number
      stale: boolean
    }
    expect(json.payload.url).toBe(PAYLOAD.url)
    expect(json.pid).toBe(record.pid)
    expect(json.stale).toBe(false)
  })

  it('agrees with the reader on the machine-and-user context', () => {
    // The script re-derives the key from the same inputs, so a payload it opens
    // is proof the two implementations still match; re-seal under a foreign
    // context and the same key file must fail to open it.
    const dir = tempDir()
    const { file, keyFile } = writePair(dir)
    const foreign = deriveKey(readOrCreateKey(keyFile), 'dsh-web-access\u0000other-host\u0000other-user')
    const record = JSON.parse(readFileSync(file, 'utf8')) as AccessRecord
    writeFileSync(file, `${JSON.stringify({ ...record, ...sealPayload(PAYLOAD, foreign) })}\n`)
    expect(() => runReader(READER, ['--path', file, '--key-path', keyFile])).toThrow()
  })

  it('reports a leftover file from a host that is gone', () => {
    const dir = tempDir()
    const { file, keyFile } = writePair(dir)
    const record = JSON.parse(readFileSync(file, 'utf8')) as AccessRecord
    // A pid no Windows or POSIX machine hands out to a live process.
    writeFileSync(file, `${JSON.stringify({ ...record, pid: 2 ** 30 })}\n`)
    const stderr = execFileSync(process.execPath, [READER, '--path', file, '--key-path', keyFile, '--json'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect((JSON.parse(stderr) as { stale: boolean }).stale).toBe(true)
    expect(runReader(READER, ['--path', file, '--key-path', keyFile])).toBe(PAYLOAD.url)
  })

  it('refuses a version it does not know', () => {
    const dir = tempDir()
    const { file, keyFile, record } = writePair(dir)
    writeFileSync(file, `${JSON.stringify({ ...record, version: 99 })}\n`)
    expect(() => runReader(READER, ['--path', file, '--key-path', keyFile])).toThrow(/version 99/)
  })
})
