#!/usr/bin/env node
/**
 * Re-record the keyless Web snapshot expectations.
 *
 * `package.json`'s `test:snapshot:record` sets `DSH_SNAPSHOT` inline, which is
 * POSIX shell syntax: on Windows `cmd.exe` reads it as an unknown command and
 * the run never starts. The merge pipeline regenerates the lifecycle-chrome
 * expectations through `local-overlay/rules.json`, so it needs a command that
 * works on both platforms. This one sets the variable in the child environment
 * and forwards every argument, so `node efai/record-snapshots.mjs -t hero`
 * narrows the run the same way the npm script does.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
// The npm script name, not a resolved binary: pnpm resolves the workspace's own
// vitest and forwards the arguments unchanged on every platform.
const args = ['exec', 'vitest', 'run', '--config', 'vitest.snapshot.config.ts', '--update', ...process.argv.slice(2)]
const result = spawnSync('pnpm', args, {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, DSH_SNAPSHOT: 'record' },
})
process.exit(result.status ?? 1)
