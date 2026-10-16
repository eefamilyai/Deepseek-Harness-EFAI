/**
 * Building one package: finding it, planning its steps, and running them in order over a
 * stand-in toolchain that records what it was asked to do.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildWorkspacePackage, findWorkspaceRoot, hostBundleConfig, resolveWorkspacePackage } from '../src/build-package.ts'

let root: string
let calls: string

/** A stand-in tool: appends its name and arguments to the call log, then exits with `code`. */
function fakeTool(path: string, label: string, code = 0): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const fs = path.endsWith('.mjs') ? "(await import('node:fs'))" : "require('node:fs')"
  writeFileSync(path, `${fs}.appendFileSync(${JSON.stringify(calls)}, ${JSON.stringify(label)} + ' ' + process.argv.slice(2).map(a => a.split(/[\\\\/]/).slice(-2).join('/')).join(' ') + '\\n'); console.log('${label} ran'); process.exit(${String(code)})`)
}

function pkg(dir: string, manifest: Record<string, unknown>, files: Record<string, string> = {}): void {
  mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, dir, 'package.json'), JSON.stringify(manifest))
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, dir, name, '..'), { recursive: true })
    writeFileSync(join(root, dir, name), content)
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-build-one-'))
  calls = join(root, 'calls.log')
  writeFileSync(calls, '')
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
  writeFileSync(join(root, 'tsconfig.host.json'), '{}')
  // The extensionless stand-in for tsc runs as CommonJS under this manifest.
  writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}')
  fakeTool(join(root, 'node_modules', 'typescript', 'bin', 'tsc'), 'tsc')
  fakeTool(join(root, 'node_modules', 'tsdown', 'dist', 'run.mjs'), 'tsdown')
  mkdirSync(join(root, 'packages', 'typert', 'generator', 'lib', 'types'), { recursive: true })
  writeFileSync(join(root, 'packages', 'typert', 'generator', 'lib', 'types', 'workspace.js'),
    `import { appendFileSync } from 'node:fs'
export class WorkspaceTypertGenerator { generate(names) { appendFileSync(${JSON.stringify(calls)}, 'typert ' + names.join(',') + '\\n'); return [] } }`)
  writeFileSync(join(root, 'packages', 'typert', 'generator', 'package.json'), '{"name":"@deepseek-ai/dsh-typert-generator","type":"module"}')
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const options = () => ({ root, nodeExecutable: process.execPath, scratchDir: join(root, 'scratch'), outputChars: 2000 })
const log = (): string[] => readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean)

describe('finding a package', () => {
  it('finds the workspace root above a nested directory', () => {
    pkg('packages/web/thing', { name: '@deepseek-ai/dsh-thing' })
    expect(findWorkspaceRoot(join(root, 'packages', 'web', 'thing'))).toBe(root)
    expect(findWorkspaceRoot(tmpdir())).toBeUndefined()
  })

  it('resolves by directory, full name, or short name, and suggests near names', () => {
    pkg('packages/web/web-thing', { name: '@deepseek-ai/dsh-web-thing' })
    expect(resolveWorkspacePackage(root, 'packages/web/web-thing').name).toBe('@deepseek-ai/dsh-web-thing')
    expect(resolveWorkspacePackage(root, '@deepseek-ai/dsh-web-thing').dir).toBe(join(root, 'packages', 'web', 'web-thing'))
    expect(resolveWorkspacePackage(root, 'web-thing').name).toBe('@deepseek-ai/dsh-web-thing')
    expect(() => resolveWorkspacePackage(root, 'thing')).toThrow(/did you mean: @deepseek-ai\/dsh-web-thing/)
  })
})

describe('building', () => {
  it('types, then bundles a Host package with the root Host pass over its existing entries', async () => {
    pkg('packages/web/plain', { name: '@deepseek-ai/dsh-plain' }, { 'tsconfig.json': '{}', 'lib/types/index.js': '', 'lib/types/invariant.js': '' })
    const results = await buildWorkspacePackage(resolveWorkspacePackage(root, 'plain'), options())
    expect(results.map(result => [result.step, result.ok, result.skipped ?? ''])).toEqual([
      ['typecheck', true, ''], ['typert', true, 'exports no ./typert, ./client/typert, or ./remote'], ['bundle', true, ''],
    ])
    expect(log()).toEqual(['tsc -b plain/tsconfig.json', 'tsdown --config scratch/tsdown.host.config.mjs'])
    const config = readFileSync(join(root, 'scratch', 'tsdown.host.config.mjs'), 'utf8')
    expect(config).toContain('index.js')
    expect(config).toContain('invariant.js')
    expect(config).not.toContain('startup.js')
  })

  it('types a Typert package Host face first, generates, then types the whole package, then uses its own bundle', async () => {
    pkg('packages/web/remote', { name: '@deepseek-ai/dsh-remote', exports: { './remote': './lib/x.js' } },
      { 'tsconfig.json': '{}', 'tsconfig.host.json': '{}', 'tsdown.config.ts': '' })
    const results = await buildWorkspacePackage(resolveWorkspacePackage(root, 'remote'), options())
    expect(results.every(result => result.ok)).toBe(true)
    expect(log()).toEqual(['tsc -b remote/tsconfig.host.json', 'typert @deepseek-ai/dsh-remote', 'tsc -b remote/tsconfig.json', 'tsdown'])
  })

  it('stops at the first failing step and keeps its output', async () => {
    fakeTool(join(root, 'node_modules', 'typescript', 'bin', 'tsc'), 'tsc', 2)
    pkg('packages/web/broken', { name: '@deepseek-ai/dsh-broken' }, { 'tsconfig.json': '{}' })
    const results = await buildWorkspacePackage(resolveWorkspacePackage(root, 'broken'), options())
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ step: 'typecheck', ok: false, output: 'tsc ran' })
  })

  it('runs only the steps asked for', async () => {
    pkg('packages/web/only', { name: '@deepseek-ai/dsh-only' }, { 'tsconfig.json': '{}', 'lib/types/index.js': '' })
    const results = await buildWorkspacePackage(resolveWorkspacePackage(root, 'only'), { ...options(), steps: ['bundle'] })
    expect(results.map(result => result.step)).toEqual(['bundle'])
    expect(log()).toEqual(['tsdown --config scratch/tsdown.host.config.mjs'])
  })

  it('fails the bundle when nothing has been emitted yet', async () => {
    pkg('packages/web/empty', { name: '@deepseek-ai/dsh-empty' })
    const results = await buildWorkspacePackage(resolveWorkspacePackage(root, 'empty'), { ...options(), steps: ['bundle'] })
    expect(results[0]).toMatchObject({ ok: false, output: 'nothing under lib/types to bundle; run the typecheck step first' })
  })
})

it('writes a Host bundle config with no imports, so it loads from any directory', () => {
  const text = hostBundleConfig(join('x', 'pkg'), ['lib/types/index.js'])
  expect(text.startsWith('export default {')).toBe(true)
  expect(text).not.toContain('import')
})
