// Validate an asar the way Electron does, with the official parser rather than my own
// reader. Prints the header, the entry count, and whether lib/main.js carries the patch.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')

for (const path of process.argv.slice(2)) {
  process.stdout.write(`\n=== ${path}\n`)
  try {
    const files = asar.listPackage(path)
    const header = asar.getRawHeader(path)
    const raw = readFileSync(path)
    process.stdout.write(`files       : ${files.length}\n`)
    process.stdout.write(`header keys : ${Object.keys(header.header ?? {}).join(',')}\n`)
    process.stdout.write(`first 16    : ${[...raw.subarray(0, 16)].join(' ')}\n`)
    const main = asar.extractFile(path, 'lib/main.js').toString('utf8')
    const at = main.indexOf('win32" && primary ? {')
    const branch = at === -1 ? '(branch not found)' : main.slice(at, at + 150).replace(/\s+/g, ' ')
    process.stdout.write(`main.js     : ${main.length} bytes | patched=${main.includes('transparent: true,\n\t\t\tbackgroundColor')}\n`)
    process.stdout.write(`win32 branch: ${branch}\n`)
    const pkg = JSON.parse(asar.extractFile(path, 'package.json').toString('utf8'))
    process.stdout.write(`package main: ${pkg.main}\n`)
  } catch (error) {
    process.stdout.write(`INVALID: ${error.constructor.name}: ${error.message}\n`)
  }
}
