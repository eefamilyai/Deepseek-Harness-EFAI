/**
 * The think and context rows' family-accent wiring as CSS text. Both compose
 * DisclosureRow, whose `.leading`/`.title` read `--dsh-row-accent` — but that
 * rule ships in the app bundle while these rebinds ship in this plugin's
 * injected stylesheet. The two are independent build artifacts, so a row that
 * spans them loses its hue whenever only one is current; each sheet must
 * therefore carry both the rebind and the colour.
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

  it.each(rows)('%s colours its own glyph, title, chevron, and dot', (name, _token, dot) => {
    const css = sheet(name)
    expect(css).toMatch(/\.root \.leading,\s*\.root \.title,\s*\.chevron\s*\{\s*color: var\(--dsh-row-accent\);/)
    expect(css).toMatch(new RegExp(`\\${dot}\\s*\\{[^}]*background: var\\(--dsh-row-accent\\)`))
  })
})
