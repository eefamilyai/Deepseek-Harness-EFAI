/**
 * Start the gateway as a detached background process.
 *
 * Useful on Windows from a terminal you want back: the gateway keeps running
 * after the shell exits, logging to `data/server.log` and writing its pid to
 * `data/gateway.pid`.
 *
 *   node scripts/start-background.cjs
 *
 * @module dswg/scripts/start-background
 */

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
fs.mkdirSync(path.join(root, 'data'), { recursive: true })
const log = fs.openSync(path.join(root, 'data', 'server.log'), 'a')
const child = spawn(process.execPath, [path.join(root, 'src', 'main.ts')], {
  detached: true,
  stdio: ['ignore', log, log],
  env: process.env,
  cwd: root,
})
child.unref()
fs.writeFileSync(path.join(root, 'data', 'gateway.pid'), String(child.pid))
console.log(`gateway started (pid ${child.pid}); logs in data/server.log`)
