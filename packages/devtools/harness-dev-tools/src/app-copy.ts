/**
 * Copying the installed Desktop application into a separate test copy.
 *
 * Two facts shape this module. Electron keeps one running instance per user-data
 * directory, and it derives that directory from the `name` in the application's
 * `app.asar` manifest; `--user-data-dir` does not change it. So the copy renames
 * its manifest — in place, at the same byte length, which leaves every offset in
 * the archive header valid. And the Host process that runs this module has Electron's
 * archive support enabled, which presents `app.asar` as a directory; the copy
 * therefore runs in a child process with `process.noAsar` set, where an archive is
 * an ordinary file.
 *
 * @module @deepseek-ai/dsh-harness-dev-tools/app-copy
 */

/** What the copy child receives through `DSH_APP_COPY_ARGS`. */
export interface AppCopyArgs {
  /** The installed application directory. */
  readonly source: string
  /** The directory the copy is written to; it is replaced. */
  readonly target: string
  /** File-name prefixes left out of the copy, such as archive backups. */
  readonly exclude: readonly string[]
  /** Skip the copy and only make sure the copy's archive carries the test name. */
  readonly renameOnly?: boolean
  /** The installed application's manifest name; required with `renameOnly`. */
  readonly installedName?: string
}

/** What the copy child prints as its last line. */
export interface AppCopyResult {
  /** The manifest name the copy now carries. */
  readonly name: string
  /** The manifest name the installed application carries. */
  readonly original: string
  /** Whether the archive was written; false when it already carried the test name. */
  readonly changed?: boolean
}

/**
 * The copy child's source, run as `node -e`. It copies the application, then renames the
 * archive manifest's `name` by changing its last character, and prints an
 * {@link AppCopyResult} as JSON.
 */
export const APP_COPY_SCRIPT = String.raw`
process.noAsar = true;
const fs = require('fs');
const path = require('path');
const args = JSON.parse(process.env.DSH_APP_COPY_ARGS);
if (!args.renameOnly) {
  fs.rmSync(args.target, { recursive: true, force: true });
  fs.cpSync(args.source, args.target, {
    recursive: true,
    filter: (from) => !args.exclude.some((prefix) => path.basename(from).startsWith(prefix)),
  });
}
const archive = path.join(args.target, 'resources', 'app.asar');
(function rename() {
const fd = fs.openSync(archive, 'r+');
try {
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const headerPickle = head.readUInt32LE(4);
  const jsonLength = head.readUInt32LE(12);
  const json = Buffer.alloc(jsonLength);
  fs.readSync(fd, json, 0, jsonLength, 16);
  const entry = JSON.parse(json.toString('utf8')).files['package.json'];
  if (!entry || entry.offset === undefined) throw new Error('app.asar has no package.json');
  const at = 8 + headerPickle + Number(entry.offset);
  const body = Buffer.alloc(entry.size);
  fs.readSync(fd, body, 0, entry.size, at);
  const text = body.toString('utf8');
  const original = JSON.parse(text).name;
  if (typeof original !== 'string' || original.length === 0) throw new Error('app.asar package.json has no name');
  // The installed name is restored from the source manifest when only renaming, so a copy
  // whose archive was swapped (carrying the installed name again) gets the test name back,
  // and an already renamed copy stays as it is.
  const installed = args.renameOnly ? args.installedName : original;
  const last = installed.at(-1);
  const name = installed.slice(0, -1) + (last === 'x' ? 'y' : 'x');
  if (original === name) { console.log(JSON.stringify({ name, original: installed, changed: false })); return; }
  const from = JSON.stringify(original);
  const index = text.indexOf(from);
  const renamed = text.slice(0, index) + JSON.stringify(name) + text.slice(index + from.length);
  if (Buffer.byteLength(renamed) !== Buffer.byteLength(text)) throw new Error('the rename changed the manifest length');
  fs.writeSync(fd, Buffer.from(renamed, 'utf8'), 0, Buffer.byteLength(renamed), at);
  console.log(JSON.stringify({ name, original: installed, changed: true }));
} finally {
  fs.closeSync(fd);
}
})();
`
