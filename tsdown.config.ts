import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from 'tsdown'
import { typertPlugin } from './packages/typert/generator/lib/types/tsdown-plugin.js'

/** Patterns for the directories the workspace build covers, one package per match. */
const WORKSPACE_PATTERNS = ['vendor/*', 'packages/*/*', 'apps/cli']

function isBuildFaceClient(value: unknown): boolean {
  if (value === undefined || value === 'host') return false
  if (value === 'client') return true
  throw new Error(`tsdown: --env.DSH_BUILD_FACE must be host or client, received ${String(value)}`)
}

/**
 * Expand one workspace pattern to the repository-relative directories that hold a package manifest.
 * A `*` segment matches child directories; every other segment is literal.
 *
 * tsdown globs its own `workspace` patterns with `onlyDirectories` and no manifest check, and names a
 * manifest-less match after the nearest enclosing package.json. Build output that a package deletion
 * strands under `packages/` therefore joins the build as `@deepseek-ai/dsh-root` and fails it on the
 * entry only a real package emits. Requiring a manifest keeps stranded output out of the build.
 * @param pattern one entry of {@link WORKSPACE_PATTERNS}.
 * @returns matched directories holding a package.json, as repository-relative POSIX paths.
 */
function workspaceDirectories(pattern: string): string[] {
  const root = import.meta.dirname
  let matches: string[] = ['']
  for (const segment of pattern.split('/')) {
    matches = matches.flatMap(parent =>
      segment === '*'
        ? readdirSync(join(root, parent), { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => (parent === '' ? entry.name : `${parent}/${entry.name}`))
        : [parent === '' ? segment : `${parent}/${segment}`],
    )
  }
  return matches.filter(directory => existsSync(join(root, directory, 'package.json')))
}

/**
 * The ordinary workspace build consumes JavaScript emitted by the Host
 * TypeScript project and runs Typert. The Client pass selects packages that
 * declare a browser bundle and lets their package-local configs emit both
 * their Node loader entry and browser artifact.
 */
export default defineConfig(({ env }) => {
  const client = isBuildFaceClient(env?.DSH_BUILD_FACE)
  return {
    workspace: WORKSPACE_PATTERNS.flatMap(workspaceDirectories),
    entry: client ? '' : ['lib/types/{index,invariant,startup}.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    plugins: client ? [] : [typertPlugin({ mode: 'workspace', faces: ['host'] })],
  }
})
