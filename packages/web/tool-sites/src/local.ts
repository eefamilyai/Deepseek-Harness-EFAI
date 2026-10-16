/**
 * The local side of a site: the credentials it uses and the folder a site can
 * be published from.
 *
 * @module @deepseek-ai/dsh-tool-sites/local
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { LIMITS, SiteError, type SiteFileContent } from './sites.ts'

const execFileAsync = promisify(execFile)

/** Runs a program and answers its standard output; tests replace it. */
export type Run = (file: string, args: readonly string[]) => Promise<string>

/**
 * Run a program, answering its trimmed standard output.
 * @param file - the program.
 * @param args - its arguments.
 * @returns the output.
 */
export const run: Run = async (file, args) =>
  (await execFileAsync(file, [...args], { windowsHide: true, timeout: 15_000 })).stdout.trim()

/**
 * A secret from the process environment, or, on Windows, from the user's
 * stored environment, which a variable set after this process started is only in.
 * @param name - the variable name.
 * @param env - the process environment.
 * @param runner - runs `reg query`.
 * @param platform - the operating system.
 * @returns the value, or undefined.
 */
export async function secret(name: string, env: NodeJS.ProcessEnv, runner: Run, platform: NodeJS.Platform): Promise<string | undefined> {
  const value = env[name]?.trim()
  if (value !== undefined && value !== '') return value
  if (platform !== 'win32') return undefined
  try {
    const out = await runner('reg', ['query', 'HKCU\\Environment', '/v', name])
    const match = new RegExp(`${name}\\s+REG_(?:EXPAND_)?SZ\\s+(\\S.*)$`, 'mu').exec(out)
    return match?.[1]?.trim()
  } catch {
    return undefined
  }
}

/**
 * The GitHub token: `GITHUB_TOKEN`, `GH_TOKEN`, or the GitHub CLI's signed-in token.
 * @param env - the process environment.
 * @param runner - runs `gh auth token`.
 * @returns the token, or undefined.
 */
export async function githubToken(env: NodeJS.ProcessEnv, runner: Run): Promise<string | undefined> {
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    const value = env[name]?.trim()
    if (value !== undefined && value !== '') return value
  }
  try {
    const token = await runner('gh', ['auth', 'token'])
    return token === '' ? undefined : token
  } catch {
    return undefined
  }
}

/** Folders never published from a site folder. */
const SKIP = new Set(['.git', 'node_modules', '.DS_Store', 'Thumbs.db'])

/** Extensions published as text; everything else goes as bytes. */
const TEXT = /\.(?:html?|css|m?js|json|svg|txt|md|xml|csv|map|webmanifest|ts|tsx|jsx)$/iu

/**
 * Read a folder into a site's files.
 * @param dir - the absolute folder.
 * @returns the files keyed by their path inside the folder.
 */
export async function readSiteFolder(dir: string): Promise<Record<string, SiteFileContent>> {
  const info = await stat(dir).catch(() => undefined)
  if (info?.isDirectory() !== true) throw new SiteError(`${dir} is not a folder`)
  const files: Record<string, SiteFileContent> = {}
  let count = 0
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue
      const path = join(folder, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (!entry.isFile()) continue
      if (++count > LIMITS.files) throw new SiteError(`${dir} has more than ${String(LIMITS.files)} files`)
      const key = relative(dir, path).replace(/\\/gu, '/')
      const bytes = await readFile(path)
      files[key] = TEXT.test(entry.name) ? bytes.toString('utf8') : { base64: bytes.toString('base64') }
    }
  }
  await walk(dir)
  return files
}

/**
 * Describe what a URL answers, for a status check.
 * @param url - the URL.
 * @returns `200`, `404`, or the reason it did not answer.
 */
export async function probe(url: string): Promise<string> {
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000) })
    await response.body?.cancel()
    return response.status >= 300 && response.status < 400
      ? `${String(response.status)} → ${response.headers.get('location') ?? '?'}`
      : String(response.status)
  } catch (error: unknown) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause
    // The name is public by now; "not found" here is this computer's resolver still caching the earlier miss.
    if (cause?.code === 'ENOTFOUND') return 'no answer (ENOTFOUND: this computer\'s DNS cache has not picked up the name yet; it clears within minutes)'
    return `no answer (${cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error))})`
  }
}
