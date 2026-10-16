// Check the patched Desktop host's profile and port selection out of the built file.
import { readFileSync } from 'node:fs'

const source = readFileSync('D:/deepseek-kernel-harness/.recon/patched-desktop-host.js', 'utf8')
const start = source.indexOf('const selectedProfile')
const end = source.indexOf('const application = runProfile')
if (start === -1 || end === -1) throw new Error('the patched selection block is not in the file')
const block = source.slice(start, end)

for (const value of [undefined, '', '   ', 'school', 'desktop']) {
  const env = value === undefined ? {} : { DSH_DESKTOP_PROFILE: value }
  const profileName = new Function('process', `${block}; return profileName;`)({ env })
  const port = profileName === 'desktop' ? '19387' : '0'
  console.log(`DSH_DESKTOP_PROFILE=${JSON.stringify(value)} -> profile=${profileName}, port=${port}`)
}
