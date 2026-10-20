#!/usr/bin/env node
/**
 * Regenerate `tsconfig.base.json` on a fresh upstream checkout.
 *
 * Two steps, in this order:
 *   1. `efai/fork-aliases.mjs` re-inserts the hand-written aliases of the
 *      fork's packages whose npm names do not match their directory names.
 *   2. upstream's `gen-tsconfig-paths` validates that every workspace package
 *      is mapped and rewrites the generated region.
 *
 * Step 1 must come first: the generator fails when a package is mapped by
 * nothing, and the fork's client packages can only be mapped by hand.
 *
 * The fork owns this file and the alias list, so an upstream update never has
 * to hand-edit `tsconfig.base.json`: take upstream's copy, run this, done.
 *
 * @module efai/regen-tsconfig-paths
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Run one step, inheriting stdio, and exit with its status. */
function step(args) {
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

step(['efai/fork-aliases.mjs'])
step(['node_modules/tsx/dist/cli.mjs', 'scripts/gen-tsconfig-paths.ts'])
