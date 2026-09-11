/**
 * A small, dependency-free ANSI renderer for the terminal pane.
 *
 * It is not a full terminal emulator — full-screen TUIs (vim, htop) that rely
 * on absolute cursor addressing will not render perfectly — but it covers the
 * cases a command shell produces: SGR colors/weights, `\r` line overwrites
 * (progress bars), and the OSC title / bare cursor sequences it silently drops.
 * The whole visible buffer is re-parsed on each render, so callers cap it.
 * @module @deepseek-ai/dsh-client-ui-dock/client/ansi
 */

import { createElement } from 'react'
import type { CSSProperties, ReactNode } from 'react'

/** The standard and bright 8-colour palettes, tuned to read on a dark surface. */
const BASE = ['#3b3f46', '#f06c6c', '#8fd460', '#e6c650', '#5b9be6', '#c088d8', '#4fd0d6', '#d7d7cf']
const BRIGHT = ['#6b7178', '#ff8a8a', '#b6f08a', '#ffe07a', '#89bdff', '#e0a6ff', '#8ff0f5', '#ffffff']

/** ESC (0x1b) and BEL (0x07) built from char codes, so no raw control byte lives in source. */
const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

interface Style {
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  inverse?: boolean
}

/** Map an xterm 256-colour index to a CSS colour. */
function xterm256(n: number): string {
  if (n < 8) return BASE[n] ?? '#d7d7cf'
  if (n < 16) return BRIGHT[n - 8] ?? '#ffffff'
  if (n < 232) {
    const c = n - 16
    const step = (v: number): number => (v === 0 ? 0 : 55 + v * 40)
    return `rgb(${step(Math.floor(c / 36))},${step(Math.floor(c / 6) % 6)},${step(c % 6)})`
  }
  const grey = 8 + (n - 232) * 10
  return `rgb(${grey},${grey},${grey})`
}

/** Fold one SGR parameter run into the running style. */
function applySgr(style: Style, params: string): Style {
  const codes = params.split(';').map(part => (part === '' ? 0 : Number.parseInt(part, 10)))
  let next: Style = { ...style }
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i] ?? 0
    if (code === 0) next = {}
    else if (code === 1) next.bold = true
    else if (code === 2) next.dim = true
    else if (code === 3) next.italic = true
    else if (code === 4) next.underline = true
    else if (code === 7) next.inverse = true
    else if (code === 22) { next.bold = false; next.dim = false }
    else if (code === 23) next.italic = false
    else if (code === 24) next.underline = false
    else if (code === 27) next.inverse = false
    else if (code >= 30 && code <= 37) next.fg = BASE[code - 30] ?? '#d7d7cf'
    else if (code === 39) delete next.fg
    else if (code >= 40 && code <= 47) next.bg = BASE[code - 40] ?? '#0b0c0f'
    else if (code === 49) delete next.bg
    else if (code >= 90 && code <= 97) next.fg = BRIGHT[code - 90] ?? '#ffffff'
    else if (code >= 100 && code <= 107) next.bg = BRIGHT[code - 100] ?? '#0b0c0f'
    else if (code === 38 || code === 48) {
      const target = code === 38 ? 'fg' : 'bg'
      if (codes[i + 1] === 5) { next[target] = xterm256(codes[i + 2] ?? 0); i += 2 }
      else if (codes[i + 1] === 2) { next[target] = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`; i += 4 }
    }
  }
  return next
}

/** Convert the running style to inline CSS, honouring inverse video. */
function styleToCss(style: Style): CSSProperties {
  const fg = style.inverse ? style.bg ?? '#0b0c0f' : style.fg
  const bg = style.inverse ? style.fg ?? '#d7d7cf' : style.bg
  const out: CSSProperties = {}
  if (fg !== undefined) out.color = fg
  if (bg !== undefined) out.background = bg
  if (style.bold === true) out.fontWeight = 700
  if (style.dim === true) out.opacity = 0.7
  if (style.italic === true) out.fontStyle = 'italic'
  if (style.underline === true) out.textDecoration = 'underline'
  return out
}

/**
 * Collapse bare `\r` overwrites within each line (keep text after the last CR).
 *
 * `\r\n` is a LINE BREAK — cmd.exe, git, npm and most Windows tools end every
 * line with it — so it must be normalized to `\n` FIRST. Only a BARE `\r`
 * returns the cursor to column 0 to overwrite the line (progress bars). Without
 * the CRLF step, every `\r\n`-terminated line's `\r` looks like an overwrite and
 * the whole line is erased, leaving only a prompt that has no trailing newline.
 */
function collapseCarriageReturns(text: string): string {
  if (!text.includes('\r')) return text
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const at = line.lastIndexOf('\r')
      return at >= 0 ? line.slice(at + 1) : line
    })
    .join('\n')
}

// OSC = ESC ] … (BEL | ESC \) — window title and friends; dropped whole.
const OSC = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, 'g')
// CSI = ESC [ params letter — only the SGR (`m`) form colours anything.
const CSI = new RegExp(`${ESC}\\[([0-9;?]*)([A-Za-z])`, 'g')

/**
 * Render an ANSI byte stream as styled React spans (place inside a `pre` with
 * `white-space: pre-wrap`).
 * @param text - the accumulated terminal output.
 * @returns styled span nodes in order.
 */
export function renderAnsi(text: string): ReactNode[] {
  const cleaned = text.replace(OSC, '')
  CSI.lastIndex = 0
  const nodes: ReactNode[] = []
  let style: Style = {}
  let last = 0
  let key = 0
  let match: RegExpExecArray | null
  const push = (raw: string): void => {
    if (raw === '') return
    nodes.push(createElement('span', { key: key++, style: styleToCss(style) }, collapseCarriageReturns(raw)))
  }
  while ((match = CSI.exec(cleaned)) !== null) {
    push(cleaned.slice(last, match.index))
    last = CSI.lastIndex
    if (match[2] === 'm') style = applySgr(style, match[1] ?? '')
    // Non-SGR CSI (cursor moves, erases) are dropped — see the module note.
  }
  push(cleaned.slice(last))
  return nodes
}
