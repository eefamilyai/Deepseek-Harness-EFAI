// Check the patched shell's profile selection out of the built archive:
// an explicit launch wins, then the recorded choice, then the shell's own profile.
import { readFileSync } from 'node:fs'

const archive = process.argv[2] ?? 'D:/Deepseek-Desktop/resources/app.asar.new'
const buffer = readFileSync(archive)
const jsonSize = buffer.readUInt32LE(12)
const base = 16 + jsonSize
const header = JSON.parse(buffer.subarray(16, base).toString('utf8'))
let entry = header
for (const part of 'lib/main.js'.split('/')) entry = entry.files[part]
const main = buffer.subarray(base + Number(entry.offset), base + Number(entry.offset) + Number(entry.size)).toString('utf8')

const start = main.indexOf('function desktopProfileName')
const end = main.indexOf('//#endregion', start)
const block = main.slice(start, end)
if (start === -1 || end === -1) throw new Error('the patched selection block is not in the bundle')

/** Evaluate the patched functions against a stubbed filesystem. */
function select({ env = {}, home = 'H:/dsh', recorded, profiles = [] } = {}) {
  const files = new Map()
  if (recorded !== undefined) files.set(`${home}/profile-hub.json`, recorded)
  for (const name of profiles) files.set(`${home}/profiles/${name}/package.json`, '{}')
  const result = new Function('process', 'resolveDshHome', 'join', 'existsSync', 'readFileSync',
    `${block}\nreturn desktopProfileName();`)(
    { env },
    () => home,
    (...parts) => parts.join('/'),
    path => files.has(path),
    path => files.get(path),
  )
  return result
}

const cases = [
  { label: 'nothing recorded', want: 'desktop' },
  { label: 'recorded launcher exists', recorded: '{"launcher":"general"}', profiles: ['general'], want: 'general' },
  { label: 'recorded launcher is gone', recorded: '{"launcher":"ghost"}', profiles: ['general'], want: 'desktop' },
  { label: 'recorded launcher is blank', recorded: '{"launcher":"   "}', want: 'desktop' },
  { label: 'record is not JSON', recorded: 'not json', want: 'desktop' },
  { label: 'record has no launcher', recorded: '{"version":1}', want: 'desktop' },
  { label: 'launch names a profile', recorded: '{"launcher":"general"}', profiles: ['general'], env: { DSH_DESKTOP_PROFILE: 'school' }, want: 'school' },
  { label: 'launch names a blank profile', recorded: '{"launcher":"general"}', profiles: ['general'], env: { DSH_DESKTOP_PROFILE: '  ' }, want: 'general' },
]

let failures = 0
for (const testCase of cases) {
  const got = select(testCase)
  const ok = got === testCase.want
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${testCase.label}: ${got}${ok ? '' : ` (wanted ${testCase.want})`}`)
}
if (failures > 0) throw new Error(`${failures} case(s) failed`)
console.log(`\nall ${cases.length} selection cases pass`)
