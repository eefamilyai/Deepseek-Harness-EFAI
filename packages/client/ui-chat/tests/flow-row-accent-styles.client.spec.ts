/**
 * The think and context rows' family-accent wiring as CSS text. A row binds
 * `--dsh-row-accent` on its own `.row` and colours its separator dot with it;
 * the row TEXT colour is DisclosureRow's (`.leading`/`.title` read the token,
 * with the neutral label tokens as the fallback). That split is upstream's: a
 * tool sheet that restates `.title` colour pins one hover state against the
 * shared process-row colours, which ui-tool's own style spec rejects.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function sheet(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/client/chat/${name}`, import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
}

const rows = [
  ['ReasoningRow.module.css', '--dsw-alias-flow-think', '.separator'],
  ['ContextInjectionRow.module.css', '--dsw-alias-flow-instruct', '.sep'],
] as const

describe('ui-chat flow-row accents', () => {
  it.each(rows)('%s rebinds its family accent on the row', (name, token) => {
    expect(sheet(name)).toMatch(new RegExp(`\\.row\\s*\\{\\s*--dsh-row-accent: var\\(${token}\\);`))
  })

  it.each(rows)('%s colours its own dot and leaves row text to the shared header', (name, _token, dot) => {
    const css = sheet(name)
    expect(css).toMatch(new RegExp(`\\${dot}\\s*\\{[^}]*background: var\\(--dsh-row-accent\\)`))
    expect(css).not.toMatch(/\.(leading|title|chevron)\s*\{[^{}]*\bcolor:/)
  })
})
