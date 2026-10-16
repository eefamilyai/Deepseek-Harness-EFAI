// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { Root, Table } from 'mdast'
import { parseGfm } from '../src/markdown/parse.ts'
import { repairMarkdownTables, tableCells } from '../src/markdown/table-repair.ts'
import { MarkdownText } from '../src/markdown/MarkdownText.tsx'
import { extractMarkdownPlainText } from '../src/markdown/plain-text.ts'

const LABELS = {
  code: {
    copyLabel: 'Copy', copiedLabel: 'Copied',
    toolbarLabels: { codeLabel: 'Code block', wrapLabel: 'Wrap lines', unwrapLabel: 'Do not wrap lines' },
  },
  footnotes: 'Footnotes',
}

/** The reply from the reported screenshot, byte for byte as the DeepSeek service streamed it. */
const SCREENSHOT = [
  '**Both fixed, and the usage history settles the coin flips:**',
  '',
  '| you said | instant? | why',
  '|---|---|---|',
  '| crow | **Google Chrome** ✓ | 0.764 tie with Cross Tools → Chrome has 14 uses, it has 0 |',
  '| crome | **Google Chrome** ✓ | 0.855 vs Comet 0.854 → usage breaks the tie |',
  '| uni client | **Lunar Client** ✓ | 0.77 vs 0.65 — a clear lead |',
  '| hap / ben | ✗ deferred | nothing plausible; not guessing |',
  'Let me check the controls still behave, and confirm end to end that "open crow" no longer calls the model at all:',
  '',
].join('\n')

const blocks = (root: Root) => root.children.map(node => node.type)
const tableOf = (root: Root) => root.children.find((node): node is Table => node.type === 'table')!

describe('table repair: prose under a table', () => {
  it('reproduces the reported defect without the repair', () => {
    const table = tableOf(parseGfm(SCREENSHOT))
    // Header plus five rows: the closing sentence became the fifth.
    expect(table.children).toHaveLength(6)
  })

  it('ends the table at the sentence written directly under it', () => {
    const root = parseGfm(repairMarkdownTables(SCREENSHOT))
    expect(blocks(root)).toEqual(['paragraph', 'table', 'paragraph'])
    expect(tableOf(root).children).toHaveLength(5)
    expect(extractMarkdownPlainText(SCREENSHOT).split('\n\n').at(-1)).toBe(
      'Let me check the controls still behave, and confirm end to end that "open crow" no longer calls the model at all:',
    )
  })

  it('inserts exactly one separator and changes nothing else', () => {
    const repaired = repairMarkdownTables(SCREENSHOT)
    expect(repaired).toBe(SCREENSHOT.replace('guessing |\nLet me', 'guessing |\n\nLet me'))
  })

  it('leaves correct documents, pipe-free text, and a table that already ends cleanly untouched', () => {
    const clean = '| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter.\n'
    expect(repairMarkdownTables(clean)).toBe(clean)
    expect(repairMarkdownTables('no tables here\nat all')).toBe('no tables here\nat all')
    expect(repairMarkdownTables('a | b\nnot a table, no delimiter\nplain')).toBe('a | b\nnot a table, no delimiter\nplain')
  })

  it('keeps rows that merely lack outer pipes, and ends at any later pipe-less line', () => {
    const doc = 'a | b\n--|--\n1 | 2\n3 | 4\nThen prose.'
    const root = parseGfm(repairMarkdownTables(doc))
    expect(blocks(root)).toEqual(['table', 'paragraph'])
    expect(tableOf(root).children).toHaveLength(3)
  })

  it('keeps the separator inside a blockquote and a list item', () => {
    const quoted = '> | a | b |\n> |---|---|\n> | 1 | 2 |\n> Quoted prose.'
    expect(repairMarkdownTables(quoted)).toBe('> | a | b |\n> |---|---|\n> | 1 | 2 |\n>\n> Quoted prose.')
    const quote = parseGfm(repairMarkdownTables(quoted)).children
    expect(quote.map(node => node.type)).toEqual(['blockquote'])
    const listed = '- item\n\n  | a | b |\n  |---|---|\n  | 1 | 2 |\n  More of the item.'
    expect(repairMarkdownTables(listed)).toBe('- item\n\n  | a | b |\n  |---|---|\n  | 1 | 2 |\n\n  More of the item.')
  })

  it('never edits fenced code, and resumes after the fence closes', () => {
    const fenced = '```\n| a | b |\n|---|---|\n| 1 | 2 |\nnot prose\n```\n| a | b |\n|---|---|\n| 1 | 2 |\nprose'
    expect(repairMarkdownTables(fenced))
      .toBe('```\n| a | b |\n|---|---|\n| 1 | 2 |\nnot prose\n```\n| a | b |\n|---|---|\n| 1 | 2 |\n\nprose')
    const tilde = '~~~~md\n| a | b |\n|---|---|\nx\n~~~\nstill code\n~~~~\nafter'
    expect(repairMarkdownTables(tilde)).toBe(tilde)
  })

  it('keeps CRLF documents in CRLF', () => {
    expect(repairMarkdownTables('| a | b |\r\n|---|---|\r\n| 1 | 2 |\r\nprose\r\n'))
      .toBe('| a | b |\r\n|---|---|\r\n| 1 | 2 |\r\n\r\nprose\r\n')
  })

  it('ends a table only where GFM starts one: header and delimiter cell counts must match', () => {
    // Without leading pipes the block is not rebuilt, so the mismatch stands and there is no table to end.
    const mismatch = 'a | b | c\n--|--\nprose'
    expect(repairMarkdownTables(mismatch)).toBe(mismatch)
    // With leading pipes the delimiter is regenerated first, and the table then ends at the prose.
    expect(repairMarkdownTables('| a | b | c |\n|---|---|\nprose')).toBe('| a | b | c |\n| --- | --- | --- |\n\nprose')
  })

  it('splits cells on unescaped pipes only', () => {
    expect(tableCells('| a \\| b | c |')).toEqual([' a \\| b ', ' c '])
    expect(tableCells('a | b')).toEqual(['a ', ' b'])
  })
})

describe('MarkdownText renders the repaired table', () => {
  it('renders the sentence outside the table, settled and while streaming chunk by chunk', () => {
    const settled = render(<MarkdownText text={SCREENSHOT} labels={LABELS} />)
    const rows = () => settled.container.querySelectorAll('tr')
    expect(rows()).toHaveLength(5)
    expect(settled.container.querySelector('table')?.textContent).not.toContain('Let me check')
    expect([...settled.container.querySelectorAll('p')].at(-1)?.textContent).toContain('Let me check the controls')
    cleanup()

    // The wire chunks of the reported reply: header + delimiter, all rows, then the sentence word by word.
    const chunks = [
      '**Both fixed, and the usage history settles the coin flips:**\n', '\n',
      '| you said | instant? | why\n|---|---|---|\n',
      SCREENSHOT.slice(SCREENSHOT.indexOf('| crow'), SCREENSHOT.indexOf('Let me')),
      'Let me', ' check the controls still behave, and confirm end to end that "open crow" no longer calls the model at all:\n',
    ]
    let text = ''
    const view = render(<MarkdownText text={text} labels={LABELS} streaming />)
    for (const chunk of chunks) {
      text += chunk
      view.rerender(<MarkdownText text={text} labels={LABELS} streaming />)
    }
    expect(view.container.querySelectorAll('tr')).toHaveLength(5)
    expect(view.container.querySelector('table')?.textContent).not.toContain('Let me')
  })
})

const rowsOf = (md: string) => tableOf(parseGfm(repairMarkdownTables(md))).children
  .map(r => r.children.map(cell => cell.children.map(child => ('value' in child ? child.value : '')).join('')))

describe('table repair: rows the service fused', () => {
  it('splits a delimiter fused with the first row, and rows fused with each other', () => {
    const doc = [
      '| Feature | Setup | App |',
      '| --- | --- | ---| Carried image | yes | no |',
      '| self-delete | 1 | 0| self-copy | 1 | 0| shortcut | 1 | 0 |',
      '| signature | none | none',
      'The installer is a carrier.',
    ].join('\n')
    expect(parseGfm(doc).children.map(node => node.type)).toEqual(['paragraph'])
    expect(rowsOf(doc)).toEqual([
      ['Feature', 'Setup', 'App'],
      ['Carried image', 'yes', 'no'],
      ['self-delete', '1', '0'],
      ['self-copy', '1', '0'],
      ['shortcut', '1', '0'],
      ['signature', 'none', 'none'],
    ])
    expect(parseGfm(repairMarkdownTables(doc)).children.map(node => node.type)).toEqual(['table', 'paragraph'])
  })

  it('splits a header fused with its delimiter, with and without the first row', () => {
    expect(rowsOf('| Package | Files | Mechanism|---|---|---|\n| `ui-chat` | 5 | rows |')).toEqual([
      ['Package', 'Files', 'Mechanism'], ['ui-chat', '5', 'rows'],
    ])
    expect(rowsOf('| || --- | ---| Repo | `McLclSerMgr` |\n| Commit | `6dd37fc` |')).toEqual([
      ['', ''], ['Repo', 'McLclSerMgr'], ['Commit', '6dd37fc'],
    ])
    expect(repairMarkdownTables('| | result|---|---|\n| Motion | one curve |'))
      .toBe('|  | result |\n| --- | --- |\n| Motion | one curve |')
  })

  it('keeps the alignment the fused delimiter carried', () => {
    expect(repairMarkdownTables('| a | b|:---|---:|\n| 1 | 2 |')).toBe('| a | b |\n| :--- | ---: |\n| 1 | 2 |')
  })

  it('rebuilds a table whose delimiter was lost under an emptied header', () => {
    const doc = '| | || Assets | two exes |\n| Digests | verified |\n| Repo | in sync |'
    expect(repairMarkdownTables(doc)).toBe(
      '|  |  |\n| --- | --- |\n| Assets | two exes |\n| Digests | verified |\n| Repo | in sync |',
    )
  })

  it('closes blank lines the service put between header, delimiter, and body', () => {
    const doc = '| endpoint | what it is\n\n| --- | ---|\n\n| `Headphones` | A2DP |\n| `Headset` | hands-free |\n\n## Next'
    expect(rowsOf(doc)).toEqual([['endpoint', 'what it is'], ['Headphones', 'A2DP'], ['Headset', 'hands-free']])
    expect(parseGfm(repairMarkdownTables(doc)).children.map(node => node.type)).toEqual(['table', 'heading'])
  })

  it('regenerates a delimiter whose cell count differs from the header', () => {
    expect(repairMarkdownTables('| a | b | c |\n|:--|--:|\n| 1 | 2 | 3 |')).toBe('| a | b | c |\n| :-- | --: | --- |\n| 1 | 2 | 3 |')
  })

  it('splits fused rows under an intact header and delimiter', () => {
    expect(repairMarkdownTables('| a | b |\n|---|---|\n| 1 | 2| 3 | 4 |\n| 5 | 6 |'))
      .toBe('| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |')
  })

  it('leaves valid tables, single-dash placeholder cells, and undecidable damage verbatim', () => {
    const valid = '| a | b |\n|---|---|\n| - | - |\n| x | y | z |\n| only |'
    expect(repairMarkdownTables(valid)).toBe(valid)
    const uneven = '| a | b|---|---|---|\n| 1 | 2 |'
    expect(repairMarkdownTables(uneven)).toBe(uneven)
    const unevenBody = '| a | b|---|---| 1 | 2 | 3 |'
    expect(repairMarkdownTables(unevenBody)).toBe(unevenBody)
    const noHeader = '| --- | ---| x | y |'
    expect(repairMarkdownTables(noHeader)).toBe(noHeader)
    const notTable = '| just | text |\n| more | text |'
    expect(repairMarkdownTables(notTable)).toBe(notTable)
    const blankLead = '| | a |\n| b | c | d |'
    expect(repairMarkdownTables(blankLead)).toBe(blankLead)
    const blankRows = '| | |\n| | |'
    expect(repairMarkdownTables(blankRows)).toBe(blankRows)
    const narrow = '| | x |\n| y |'
    expect(repairMarkdownTables(narrow)).toBe(narrow)
    const filledLead = '| | x | a | b |\n| c | d |'
    expect(repairMarkdownTables(filledLead)).toBe(filledLead)
  })

  it('does not merge a header-only table with the next table', () => {
    const doc = '| a | b |\n|---|---|\n\n| x | y |\n|---|---|\n| 1 | 2 |'
    expect(repairMarkdownTables(doc)).toBe(doc)
  })

  it('keeps container prefixes and CRLF terminators on rebuilt rows', () => {
    expect(repairMarkdownTables('> | a | b|---|---| 1 | 2 |\r\n> | 3 | 4 |'))
      .toBe('> | a | b |\r\n> | --- | --- |\r\n> | 1 | 2 |\r\n> | 3 | 4 |')
  })

  it('renders the rebuilt table while streaming and once settled', () => {
    const doc = 'Shipped:\n\n| || --- | ---| Commit | `379f30e` |\n| Version | 2.0.3 |\nDone.'
    const settled = render(<MarkdownText text={doc} labels={LABELS} />)
    expect(settled.container.querySelectorAll('tr')).toHaveLength(3)
    cleanup()
    let text = ''
    const view = render(<MarkdownText text={text} labels={LABELS} streaming />)
    for (const chunk of ['Shipped:\n\n', '| || --- | ---| Commit | `379f30e` |\n', '| Version | 2.0.3 |\n', 'Done.']) {
      text += chunk
      view.rerender(<MarkdownText text={text} labels={LABELS} streaming />)
    }
    expect(view.container.querySelectorAll('tr')).toHaveLength(3)
    expect([...view.container.querySelectorAll('p')].at(-1)?.textContent).toBe('Done.')
  })
})
