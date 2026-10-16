// Flatten the pnpm virtual store in a deployed app tree into a real, hoisted
// node_modules.
//
// `pnpm deploy --legacy` always materialises a virtual store at
// node_modules/.pnpm and links the top level into it. Those links do not
// survive zipping, and the store's "<id>/node_modules/<pkg>" layout pushes
// paths past the Windows MAX_PATH limit once the archive is extracted
// anywhere but a drive root. This script moves every package out of the store
// so node_modules holds real directories only.
//
// Usage: node flatten-tree.mjs <appDir>

import {
  readdirSync, lstatSync, existsSync, renameSync, rmSync,
  realpathSync, mkdirSync, statSync,
} from 'node:fs';
import { join, dirname } from 'node:path';

const appDir = process.argv[2];
if (!appDir) {
  console.error('usage: node flatten-tree.mjs <appDir>');
  process.exit(2);
}

const nm = join(appDir, 'node_modules');
const store = join(nm, '.pnpm');
const hasStore = existsSync(store);

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isLink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
// realpathSync throws on a dangling link, and the store routinely contains
// links whose target was never materialised. A null result means "not usable".
const real = (p) => { try { return realpathSync(p); } catch { return null; } };
const list = (p) => { try { return readdirSync(p); } catch { return []; } };

// ---------------------------------------------------------------- inventory
// Desired final layout: node_modules/<name> is a real directory for every
// package the store provides. Names are "pkg" or "@scope/pkg".
const wanted = new Map();   // name -> absolute source path in the store

function offer(name, src) {
  if (wanted.has(name)) return;
  if (!src || !isDir(src)) return;
  wanted.set(name, src);
}

for (const id of (hasStore ? list(store) : [])) {
  const inner = join(store, id, 'node_modules');
  if (!isDir(inner)) continue;

  for (const entry of list(inner)) {
    if (entry === '.bin') continue;
    const p = join(inner, entry);

    if (entry.startsWith('@')) {
      if (!isDir(p)) continue;
      for (const sub of list(p)) {
        const sp = join(p, sub);
        offer(`${entry}/${sub}`, isLink(sp) ? real(sp) : sp);
      }
    } else {
      offer(entry, isLink(p) ? real(p) : p);
    }
  }
}

// ---------------------------------------------------------------- placement
// A name that is currently a top-level symlink is the authoritative choice:
// that is exactly what node resolved before, so it must win over any other
// version the store happens to hold.
const pinned = new Map();
for (const entry of list(nm)) {
  if (entry === '.pnpm' || entry === '.bin') continue;
  const p = join(nm, entry);
  if (entry.startsWith('@') && isDir(p) && !isLink(p)) {
    for (const sub of list(p)) {
      const sp = join(p, sub);
      if (!isLink(sp)) continue;
      const r = real(sp);
      if (r && isDir(r)) pinned.set(`${entry}/${sub}`, r);
    }
  } else if (isLink(p)) {
    const r = real(p);
    if (r && isDir(r)) pinned.set(entry, r);
  }
}

const order = [...wanted.keys()].sort((a, b) => {
  const pa = pinned.has(a) ? 0 : 1;
  const pb = pinned.has(b) ? 0 : 1;
  return pa - pb || a.localeCompare(b);
});

let moved = 0;
let kept = 0;
for (const name of order) {
  const dest = join(nm, name);
  if (isDir(dest) && !isLink(dest)) { kept++; continue; }

  const finalSrc = pinned.get(name) ?? wanted.get(name);
  if (!finalSrc || !isDir(finalSrc) || finalSrc === dest) { kept++; continue; }

  mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(dest) || isLink(dest)) rmSync(dest, { recursive: true, force: true });
  try {
    renameSync(finalSrc, dest);
    moved++;
  } catch {
    kept++;
  }
}

// ---------------------------------------------------------------- teardown
// Everything worth keeping was hoisted to the top level, so any link still
// present is redundant: its package is already reachable by name from the app
// root, which is where Node's resolution would find it. A portable tree must
// contain real directories only, so every remaining link goes.
//
// The walk is iterative and unbounded in depth on purpose. pnpm nests
// node_modules inside packages, and a copied workspace package can carry a
// chain several levels deep; a recursive sweep with a depth cap silently
// leaves thousands of links behind. A visited set keyed by real path keeps a
// junction cycle from looping forever.
function scrub(root) {
  let removed = 0;
  const seen = new Set();
  const stack = [root];

  while (stack.length) {
    const dir = stack.pop();
    let key;
    try { key = realpathSync(dir); } catch { key = dir; }
    if (seen.has(key)) continue;
    seen.add(key);

    for (const entry of list(dir)) {
      const full = join(dir, entry);
      let st;
      try { st = lstatSync(full); } catch { continue; }

      if (st.isSymbolicLink()) {
        try { rmSync(full, { recursive: true, force: true }); removed++; } catch {}
      } else if (st.isDirectory()) {
        stack.push(full);
      }
    }
  }
  return removed;
}
const dropped = scrub(nm);

// Nothing resolves through the store any more: every package name it offered is
// already a real top-level directory (hoisted above or already real), and the
// scrub just deleted the links that pointed inside it. What remains is dead
// weight whose "<id>/node_modules/<pkg>" layout is what pushes extracted paths
// toward the Windows MAX_PATH limit, so it goes for good. Failure to delete is
// fatal: a store that quietly survives ships 4,000 files nobody can resolve.
let storeRemoved = false;
if (hasStore) {
  try {
    rmSync(store, { recursive: true, force: true });
    storeRemoved = !existsSync(store);
  } catch (error) {
    console.error(`flatten: could not remove ${store}: ${error.message}`);
  }
}

console.log(`flatten: moved ${moved} package(s) out of the store, kept ${kept}, dropped ${dropped} link(s)`);
if (!hasStore) {
  console.log('flatten: no store present (already flattened)');
} else if (storeRemoved) {
  console.log('flatten: removed node_modules/.pnpm');
} else {
  console.error('flatten: node_modules/.pnpm survived; the tree is not portable');
  process.exit(1);
}
