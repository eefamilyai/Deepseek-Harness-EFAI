
/**
 * Complete a pnpm-deployed app tree so the Cordis loader can boot from it.
 *
 * `pnpm deploy --prod` materialises the production dependency closure, but the
 * Cordis loader resolves plugin packages that arrive as *peer* dependencies --
 * `@deepseek-ai/cordis-plugin-group` is one -- which the production closure
 * omits. The repository only works because `packages/boot/app-boot/node_modules`
 * happens to link them.
 *
 * This script walks the deployed tree, collects every `@deepseek-ai/*` package
 * name referenced by a deployed manifest, copies the ones that are missing at
 * the app root out of `vendor/` and `packages/`, and repeats until the set stops
 * growing.
 *
 * Names with no source in the repository (optional platform binaries, the
 * unbuilt web frontend) are reported and skipped: they are declared as optional
 * or platform-specific dependencies and are not needed to boot.
 *
 * Usage: node complete-tree.mjs <repoRoot> <appDir>
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';

const [, , repoRoot, appDir] = process.argv;
if (!repoRoot || !appDir) {
  console.error('usage: node complete-tree.mjs <repoRoot> <appDir>');
  process.exit(2);
}

const SCOPE = '@deepseek-ai/';
const SKIP_DIRS = new Set(['node_modules', '.git']);

/** Index every `@deepseek-ai/*` package source in the repository, vendor first. */
function indexSources() {
  const index = new Map();
  const walk = (base) => {
    if (!existsSync(base)) return;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      const dir = join(base, entry.name);
      const manifest = join(dir, 'package.json');
      if (existsSync(manifest)) {
        try {
          const { name } = JSON.parse(readFileSync(manifest, 'utf8'));
          if (name?.startsWith(SCOPE) && !index.has(name)) index.set(name, dir);
        } catch {
          // A manifest that does not parse cannot be a package source; skip it.
        }
      }
      walk(dir);
    }
  };
  walk(join(repoRoot, 'vendor'));
  walk(join(repoRoot, 'packages'));
  return index;
}

/** Every installed `@deepseek-ai` package directory inside the deployed tree. */
function installedPackages(root) {
  const found = [];
  const seen = new Set();
  const visit = (dir, depth) => {
    if (depth > 8 || !existsSync(dir)) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = join(dir, entry.name);
      if (entry.name === '@deepseek-ai') {
        for (const scoped of readdirSync(child, { withFileTypes: true })) {
          const pkgDir = join(child, scoped.name);
          if (!seen.has(pkgDir) && existsSync(join(pkgDir, 'package.json'))) {
            seen.add(pkgDir);
            found.push(pkgDir);
          }
        }
        continue;
      }
      visit(child, depth + 1);
    }
  };
  visit(root, 0);
  return found;
}

const DEP_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];

function referencedNames(pkgDir) {
  try {
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    const names = new Set();
    for (const field of DEP_FIELDS) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        if (name.startsWith(SCOPE)) names.add(name);
      }
    }
    return names;
  } catch {
    return new Set();
  }
}

/** Copy a package source without its own installed dependencies or build residue. */
function copyPackage(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, {
    recursive: true,
    dereference: true,
    filter: (path) => {
      const name = path.slice(path.lastIndexOf(sep) + 1);
      return !SKIP_DIRS.has(name) && !name.endsWith('.tsbuildinfo');
    },
  });
}

const sources = indexSources();
const scopeDir = join(appDir, 'node_modules', '@deepseek-ai');
mkdirSync(scopeDir, { recursive: true });

const added = [];
const unavailable = new Set();
for (let round = 0; round < 12; round += 1) {
  const installed = installedPackages(appDir);
  const referenced = new Set();
  for (const pkgDir of installed) {
    for (const name of referencedNames(pkgDir)) referenced.add(name);
  }

  const missing = [...referenced]
    .filter((name) => !existsSync(join(scopeDir, name.slice(SCOPE.length))))
    .sort();
  if (missing.length === 0) {
    console.log(`  references resolved across ${installed.length} @deepseek-ai packages`);
    break;
  }

  let progressed = false;
  for (const name of missing) {
    const src = sources.get(name);
    if (!src) {
      unavailable.add(name);
      continue;
    }
    copyPackage(src, join(scopeDir, name.slice(SCOPE.length)));
    added.push(name);
    progressed = true;
  }
  if (!progressed) break;
}

if (added.length > 0) {
  console.log(`  added ${added.length} workspace package(s) to the app root`);
}
if (unavailable.size > 0) {
  console.log(`  skipped ${unavailable.size} package(s) with no repository source (optional/platform-specific):`);
  for (const name of [...unavailable].sort()) console.log(`      ${name}`);
}

const entry = join(appDir, 'lib', 'bin.js');
if (!existsSync(entry) || !statSync(entry).isFile()) {
  console.error(`  !! entry point missing or not a file: ${entry}`);
  process.exit(1);
}
console.log('  tree completion finished');
