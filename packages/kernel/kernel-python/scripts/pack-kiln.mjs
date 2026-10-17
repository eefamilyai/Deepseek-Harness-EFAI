// Copy the Kiln runtime into this package as `kiln/`, so a packed install (the
// Desktop's package set) carries the kernel it starts. Source checkouts read
// python/kiln/runtime directly; this copy exists only for packing.
//
// Exactly the files git tracks are copied: the runtime folder also holds the
// uv virtualenv, tool results, screenshots, and scratch, none of which ship.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..', '..', '..')
const prefix = 'python/kiln/runtime/'
const target = resolve(here, '..', 'kiln')

const tracked = execFileSync('git', ['-C', repo, 'ls-files', '-z', prefix], { encoding: 'utf8' })
  .split('\0').filter(path => path.startsWith(prefix) && !/(?:^|\/)test_[^/]*\.py$/u.test(path))
if (!tracked.includes(`${prefix}kernel_child.py`)) throw new Error('pack-kiln: kernel_child.py is not tracked under python/kiln/runtime')
rmSync(target, { recursive: true, force: true })
for (const path of tracked) {
  const to = join(target, path.slice(prefix.length))
  mkdirSync(dirname(to), { recursive: true })
  if (existsSync(join(repo, path))) copyFileSync(join(repo, path), to)
}
console.log(`pack-kiln: copied ${String(tracked.length)} tracked files to ${target}`)
