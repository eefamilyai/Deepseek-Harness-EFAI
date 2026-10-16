/**
 * Building one workspace package the way the root build would, without building the
 * whole workspace.
 *
 * The root `pnpm run build` runs every package's TypeScript emit, then generates the
 * Typert artifacts, then bundles. For one package the same three steps are: `tsc -b`
 * over the package's `tsconfig.json`; the Typert generator for that package alone when
 * it exports `./typert`, `./client/typert`, or `./remote`; and `tsdown` — the
 * package's own `tsdown.config.ts` when it has one (Client packages do), otherwise
 * the root Host pass over `lib/types/{index,invariant,startup}.js`.
 *
 * @module @deepseek-ai/dsh-harness-dev-tools/build-package
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

/** The build steps, in the order they run. */
export const BUILD_STEPS = ['typecheck', 'typert', 'bundle'] as const
/** One build step. */
export type BuildStep = typeof BUILD_STEPS[number]

/** One workspace package as the build reads it. */
export interface WorkspacePackage {
  /** Absolute package directory. */
  readonly dir: string
  /** The manifest `name`. */
  readonly name: string
  /** Whether the manifest exports a Typert or Remote artifact. */
  readonly typert: boolean
  /** Whether the package carries its own `tsdown.config.ts`. */
  readonly ownBundle: boolean
  /** The Host pass entries that exist under `lib/types`, relative to the package. */
  readonly hostEntries: readonly string[]
}

/** The outcome of one step. */
export interface StepResult {
  readonly step: BuildStep
  readonly ok: boolean
  /** Why the step did not run, when it was skipped. */
  readonly skipped?: string
  /** The command's output, ANSI colour removed, last part only. */
  readonly output: string
  readonly ms: number
}

/** Remove terminal colour codes. */
function plain(text: string): string {
  return text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'gu'), '')
}

/**
 * Find the workspace root above a directory: the nearest one holding both
 * `pnpm-workspace.yaml` and `tsconfig.host.json`.
 * @param start - where to begin.
 * @returns the root, or undefined outside a workspace.
 */
export function findWorkspaceRoot(start: string): string | undefined {
  let current = resolve(start)
  while (true) {
    if (existsSync(join(current, 'pnpm-workspace.yaml')) && existsSync(join(current, 'tsconfig.host.json'))) return current
    const parent = resolve(current, '..')
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * Read one package directory.
 * @param dir - absolute package directory.
 * @returns the package, or undefined when the directory has no manifest.
 */
export function readWorkspacePackage(dir: string): WorkspacePackage | undefined {
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) return undefined
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown; exports?: unknown }
  if (typeof manifest.name !== 'string') return undefined
  const exportsField = typeof manifest.exports === 'object' && manifest.exports !== null ? manifest.exports : {}
  return {
    dir,
    name: manifest.name,
    typert: ['./typert', './client/typert', './remote'].some(key => Object.hasOwn(exportsField, key)),
    ownBundle: existsSync(join(dir, 'tsdown.config.ts')),
    hostEntries: ['index', 'invariant', 'startup'].map(entry => `lib/types/${entry}.js`),
  }
}

/**
 * Resolve a package named by directory or manifest name.
 * @param root - the workspace root.
 * @param spec - a path (absolute or root-relative) or a package name such as `@deepseek-ai/dsh-web-browser`.
 * @returns the package.
 * @throws Error naming the closest candidates when nothing matches.
 */
export function resolveWorkspacePackage(root: string, spec: string): WorkspacePackage {
  const asPath = isAbsolute(spec) ? spec : join(root, spec)
  const direct = existsSync(asPath) ? readWorkspacePackage(resolve(asPath)) : undefined
  if (direct !== undefined) return direct
  const candidates: WorkspacePackage[] = []
  for (const top of ['packages', 'vendor', 'apps']) {
    const base = join(root, top)
    if (!existsSync(base)) continue
    for (const group of readdirSync(base, { withFileTypes: true })) {
      if (!group.isDirectory()) continue
      const groupDir = join(base, group.name)
      const own = readWorkspacePackage(groupDir)
      if (own !== undefined) candidates.push(own)
      for (const child of readdirSync(groupDir, { withFileTypes: true })) {
        if (!child.isDirectory() || child.name === 'node_modules') continue
        const found = readWorkspacePackage(join(groupDir, child.name))
        if (found !== undefined) candidates.push(found)
      }
    }
  }
  const exact = candidates.find(candidate => candidate.name === spec || candidate.name === `@deepseek-ai/dsh-${spec}`)
  if (exact !== undefined) return exact
  const near = candidates.filter(candidate => candidate.name.includes(spec)).map(candidate => candidate.name).slice(0, 8)
  throw new Error(`no workspace package "${spec}"${near.length > 0 ? `; did you mean: ${near.join(', ')}` : ''}`)
}

/** What one command exited with, and everything it printed. */
interface CommandOutcome {
  readonly code: number | null
  readonly output: string
}

/** Run one command and capture its combined output. */
function run(
  command: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal | undefined,
  env: NodeJS.ProcessEnv,
): Promise<CommandOutcome> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = ''
    const collect = (chunk: Buffer): void => { output += chunk.toString('utf8') }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const abort = (): void => { child.kill() }
    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', (error) => { signal?.removeEventListener('abort', abort); reject(error) })
    child.on('close', (code) => { signal?.removeEventListener('abort', abort); resolvePromise({ code, output: plain(output) }) })
  })
}

/** Inputs the build needs beyond the package. */
export interface BuildOptions {
  /** The workspace root. */
  readonly root: string
  /** The executable that runs Node scripts. */
  readonly nodeExecutable: string
  /** Where generated build configs are written. */
  readonly scratchDir: string
  /** The steps to run; every step by default. */
  readonly steps?: readonly BuildStep[]
  /** Characters of output kept per step. */
  readonly outputChars: number
  /** Abandons the build; the running command is killed. */
  readonly signal?: AbortSignal | undefined
}

/**
 * Build one package.
 *
 * A package that generates Typert artifacts and splits its compiler faces is typed in
 * two passes: the Host face first, because the generator reads its emit, and the whole
 * package after generation, because the Client face imports the generated Remote
 * declarations.
 * @param pkg - the package.
 * @param options - root, Node executable, scratch directory, steps, and output cap.
 * @returns one result per command run or step skipped; a failed command stops the rest.
 */
export async function buildWorkspacePackage(pkg: WorkspacePackage, options: BuildOptions): Promise<StepResult[]> {
  const steps = options.steps ?? BUILD_STEPS
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1', FORCE_COLOR: '0' }
  const keep = (text: string): string => (text.length <= options.outputChars ? text.trim() : `…${text.slice(-options.outputChars).trim()}`)
  const node = options.nodeExecutable
  const tsc = join(options.root, 'node_modules', 'typescript', 'bin', 'tsc')
  const tsdown = join(options.root, 'node_modules', 'tsdown', 'dist', 'run.mjs')
  const tsconfig = join(pkg.dir, 'tsconfig.json')
  const hostTsconfig = join(pkg.dir, 'tsconfig.host.json')
  const twoPass = pkg.typert && steps.includes('typert') && existsSync(hostTsconfig)

  /** One command of the plan, or the reason its step does not run. */
  type Planned =
    | { readonly step: BuildStep; readonly command: () => Promise<CommandOutcome> }
    | { readonly step: BuildStep; readonly skipped: string }
  const plan: Planned[] = []
  if (steps.includes('typecheck')) {
    if (!existsSync(tsconfig)) plan.push({ step: 'typecheck', skipped: 'no tsconfig.json' })
    else plan.push({ step: 'typecheck', command: () => run(node, [tsc, '-b', twoPass ? hostTsconfig : tsconfig], options.root, options.signal, env) })
  }
  if (steps.includes('typert')) {
    const generator = join(options.root, 'packages', 'typert', 'generator', 'lib', 'types', 'workspace.js')
    if (!pkg.typert) plan.push({ step: 'typert', skipped: 'exports no ./typert, ./client/typert, or ./remote' })
    else if (!existsSync(generator)) plan.push({ step: 'typert', skipped: `the Typert generator is not built (${relative(options.root, generator)})` })
    else {
      plan.push({
        step: 'typert',
        command: async () => {
          await mkdir(options.scratchDir, { recursive: true })
          const script = join(options.scratchDir, 'typert-one.mjs')
          await writeFile(script, TYPERT_ONE_SCRIPT)
          return run(node, [script, generator, options.root, pkg.name], options.root, options.signal, env)
        },
      })
      if (twoPass && steps.includes('typecheck')) {
        plan.push({ step: 'typecheck', command: () => run(node, [tsc, '-b', tsconfig], options.root, options.signal, env) })
      }
    }
  }
  if (steps.includes('bundle')) {
    if (pkg.ownBundle) plan.push({ step: 'bundle', command: () => run(node, [tsdown], pkg.dir, options.signal, env) })
    else {
      plan.push({
        step: 'bundle',
        command: async () => {
          const entries = pkg.hostEntries.filter(entry => existsSync(join(pkg.dir, entry)))
          if (entries.length === 0) return { code: 1, output: 'nothing under lib/types to bundle; run the typecheck step first' }
          await mkdir(options.scratchDir, { recursive: true })
          const config = join(options.scratchDir, 'tsdown.host.config.mjs')
          await writeFile(config, hostBundleConfig(pkg.dir, entries))
          return run(node, [tsdown, '--config', config], pkg.dir, options.signal, env)
        },
      })
    }
  }

  const results: StepResult[] = []
  for (const entry of plan) {
    if ('skipped' in entry) {
      results.push({ step: entry.step, ok: true, skipped: entry.skipped, output: '', ms: 0 })
      continue
    }
    const started = Date.now()
    const outcome = await entry.command()
    const ok = outcome.code === 0
    results.push({ step: entry.step, ok, output: keep(outcome.output), ms: Date.now() - started })
    if (!ok) break
  }
  return results
}

/**
 * The root build's Host bundle pass, for one package.
 * @param dir - the package directory.
 * @param entries - the `lib/types` entries that exist.
 * @returns a tsdown config module with no imports, so it loads from any directory.
 */
export function hostBundleConfig(dir: string, entries: readonly string[]): string {
  const config = {
    cwd: dir,
    entry: entries.map(entry => join(dir, entry)),
    outDir: join(dir, 'lib'),
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  }
  return `export default ${JSON.stringify(config, null, 2)}\n`
}

/**
 * Generates one package's Typert artifacts with the built generator and writes them
 * where the root build's plugin writes them. Arguments: generator module, root, package name.
 */
export const TYPERT_ONE_SCRIPT = `import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const [generatorPath, root, name] = process.argv.slice(2)
const { WorkspaceTypertGenerator } = await import(pathToFileURL(generatorPath).href)
const generator = new WorkspaceTypertGenerator(root, { checkDiagnostics: false })
const artifacts = generator.generate([name])
if (artifacts.length === 0) { console.log('no Typert artifacts for ' + name); process.exit(0) }
for (const artifact of artifacts) {
  const out = join(root, artifact.packageRoot, 'lib')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'typert.' + artifact.face + '.js'), artifact.js)
  writeFileSync(join(out, 'typert.' + artifact.face + '.d.ts'), artifact.dts)
  if (artifact.remote !== undefined) {
    writeFileSync(join(out, 'typert.remote-client.js'), artifact.remote.js)
    writeFileSync(join(out, 'typert.remote-client.d.ts'), artifact.remote.dts)
    writeFileSync(join(out, 'typert.remote-client.d.ts.map'), artifact.remote.dtsMap)
  }
  console.log('wrote typert.' + artifact.face + (artifact.remote !== undefined ? ' and typert.remote-client' : '') + ' for ' + name)
}
`
