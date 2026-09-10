import { Fragment, useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { writeClipboard } from '../clipboard.ts'
// DSH-FORK(brand): fork edit on an upstream-owned file. EXIT: upstream adopts the fork's code-block chrome.
import { IconCheckOutline14, IconCopyOutline16, IconDownloadOutline16, IconPlayOutline16 } from '../icons/index.tsx'
import {
  StreamingHighlightSession, grammarLoadCount, highlightToHtml, subscribeGrammarLoaded,
} from './highlight.ts'
import type { HighlightSpan, StreamingHighlightFrame } from './highlight.ts'
import { useViewportHighlighting } from './useViewportHighlighting.ts'
import css from './CodeBlock.module.css'

export interface CodeBlockProps {
  /** The source text, rendered verbatim (trailing newline trimmed for display). */
  code: string
  /** Grammar hint (markdown fence info string or a fixed caller id); unknown = plain. */
  lang?: string | undefined
  /**
   * The code is still growing (a streaming markdown fence): highlight through
   * a per-instance {@link StreamingHighlightSession}, which re-tokenizes only
   * appended text and keeps completed line groups (and DOM) untouched. The
   * caller must keep the component instance stable across growth (a
   * stream-stable React key); an unchanged streamed fence also retains that
   * tree when it settles. Cold settled callers get shiki's HTML.
   */
  streaming?: boolean | undefined
  /** Extra class merged onto the wrapper (callers position; this component draws). */
  className?: string | undefined
  /** Copy-button idle label; the owner passes localized copy (this package is cordis-free, so copy arrives via props). */
  copyLabel: string
  /** Copy-button label during the post-copy confirmation window. */
  copiedLabel: string
  /** Run-button label. Absent hides the Run button. */
  runLabel?: string | undefined
  /** Download-button label. Absent hides the Download button. */
  downloadLabel?: string | undefined
  /** Invoked with the trimmed code when the user presses Run. */
  onRun?: ((code: string) => void) | undefined
}


/** Map a fence language hint to a downloadable filename, with a text fallback. */
function filenameForLang(lang: string | undefined): string {
  switch (lang?.toLowerCase()) {
    case 'js': case 'mjs': case 'cjs': case 'jsx': return 'code.js'
    case 'ts': case 'mts': case 'cts': case 'tsx': return 'code.ts'
    case 'py': case 'python': return 'code.py'
    case 'sh': case 'bash': case 'zsh': return 'code.sh'
    case 'ps1': case 'pwsh': case 'powershell': return 'code.ps1'
    case 'cmd': case 'bat': return 'code.cmd'
    case 'json': return 'code.json'
    case 'jsonc': return 'code.jsonc'
    case 'yaml': case 'yml': return 'code.yml'
    case 'toml': return 'code.toml'
    case 'html': return 'code.html'
    case 'css': return 'code.css'
    case 'scss': return 'code.scss'
    case 'less': return 'code.less'
    case 'sql': return 'code.sql'
    case 'go': return 'code.go'
    case 'rs': return 'code.rs'
    case 'java': return 'code.java'
    case 'c': return 'code.c'
    case 'h': return 'code.h'
    case 'cpp': case 'cc': case 'cxx': return 'code.cpp'
    case 'cs': return 'code.cs'
    case 'rb': return 'code.rb'
    case 'php': return 'code.php'
    case 'swift': return 'code.swift'
    case 'kt': case 'kotlin': return 'code.kt'
    case 'lua': return 'code.lua'
    case 'md': return 'code.md'
    default: return 'code.txt'
  }
}

/** Client-side Blob save; no-op on hosts without object URLs (jsdom). */
function downloadCode(code: string, lang: string | undefined): void {
  if (typeof URL.createObjectURL !== 'function') return
  const url = URL.createObjectURL(new Blob([code], { type: 'text/plain;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filenameForLang(lang)
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => { URL.revokeObjectURL(url) }, 0)
}

/**
 * The `pre` attributes shiki's HTML arm emits for the css-variables theme,
 * mirrored so the streaming arm's tree is interchangeable with the settled
 * swap (`tests/streaming-code-block.client.spec.tsx` pins the two arms'
 * parity).
 */
const SHIKI_PRE_PROPS = {
  className: 'shiki css-variables',
  style: { backgroundColor: 'var(--shiki-background)', color: 'var(--shiki-foreground)' },
  tabIndex: 0,
} as const

/** Completed-line group size; React reconciles groups while the DOM remains line-for-line identical. */
const STREAMING_LINE_GROUP_SIZE = 32

function renderLine(line: readonly HighlightSpan[], index: number): ReactNode {
  return (
    <Fragment key={index}>
      {index > 0 && '\n'}
      <span className="line">
        {line.map((span, spanIndex) => <span key={spanIndex} style={span.style}>{span.text}</span>)}
      </span>
    </Fragment>
  )
}

export function CodeBlock({ code, lang, streaming, className, copyLabel, copiedLabel, runLabel, downloadLabel, onRun }: CodeBlockProps) {
  const trimmed = code.endsWith('\n') ? code.slice(0, -1) : code
  const rootRef = useRef<HTMLDivElement>(null)
  const highlighting = useViewportHighlighting(rootRef, lang)
  // Re-render when a lazy grammar finishes loading, so a fence that showed plain
  // text while its language's grammar imported picks up highlighting. The
  // snapshot value is opaque; only its change across renders drives the memo.
  const loaded = useSyncExternalStore(subscribeGrammarLoaded, grammarLoadCount, grammarLoadCount)
  // Streaming state lives in refs mutated inside the memo (the MarkdownText
  // streaming-cache pattern): the session's caches carry across chunks only
  // because the owner keys this instance stably while the fence grows.
  const sessionRef = useRef<StreamingHighlightSession | null>(null)
  const lineCacheRef = useRef<{
    code: string
    lang: string | undefined
    generation: number
    frame: StreamingHighlightFrame
    groups: ReactNode[]
    pending: ReactNode[]
    nextLine: number
    body: ReactNode
  } | null>(null)
  const settledRef = useRef(false)
  const streamedBody = useMemo(() => {
    if (!highlighting) {
      sessionRef.current = null
      lineCacheRef.current = null
      settledRef.current = false
      return undefined
    }
    if (streaming !== true) {
      const previous = lineCacheRef.current
      if (previous !== null && previous.code === trimmed && previous.lang === lang) {
        settledRef.current = true
        return previous.body
      }
      sessionRef.current = null
      lineCacheRef.current = null
      settledRef.current = true
      return undefined
    }
    if (settledRef.current) {
      sessionRef.current = null
      lineCacheRef.current = null
      settledRef.current = false
    }
    sessionRef.current ??= new StreamingHighlightSession()
    const frame = sessionRef.current.updateFrame(trimmed, lang)
    if (frame === undefined) {
      lineCacheRef.current = null
      return undefined
    }
    const previous = lineCacheRef.current
    if (previous?.frame === frame && previous.code === trimmed && previous.lang === lang) {
      return previous.body
    }
    const sameGeneration = previous?.generation === frame.generation
    const groups = sameGeneration ? [...previous.groups] : []
    let pending = sameGeneration ? [...previous.pending] : []
    let nextLine = sameGeneration ? previous.nextLine : 0
    for (const line of frame.appended) {
      pending.push(renderLine(line, nextLine))
      nextLine += 1
      if (pending.length !== STREAMING_LINE_GROUP_SIZE) continue
      const start = nextLine - pending.length
      groups.push(<Fragment key={start}>{pending}</Fragment>)
      pending = []
    }
    const tail = frame.tail.map((line, index) => renderLine(line, nextLine + index))
    const tailGroup = <Fragment key={nextLine - pending.length}>{[...pending, ...tail]}</Fragment>
    const body = <pre {...SHIKI_PRE_PROPS}><code>{groups}{tailGroup}</code></pre>
    lineCacheRef.current = {
      code: trimmed, lang, generation: frame.generation, frame, groups, pending, nextLine, body,
    }
    return body
  }, [streaming, highlighting, trimmed, lang, loaded])
  const html = useMemo(
    () => (highlighting && streaming !== true && streamedBody === undefined
      ? highlightToHtml(trimmed, lang)
      : undefined),
    [streaming, highlighting, streamedBody, trimmed, lang, loaded],
  )
  const [copied, setCopied] = useState(false)

  const onDownload = useCallback(() => {
    downloadCode(trimmed, lang)
  }, [trimmed, lang])

  const onRunClick = useCallback(() => {
    onRun?.(trimmed)
  }, [onRun, trimmed])

  const onCopy = useCallback(() => {
    if (copied) return
    /* v8 ignore next -- both arms always mount a <pre>; trimmed is the
       typed fallback if the DOM shape ever diverges. */
    const text = rootRef.current?.querySelector('pre')?.textContent ?? trimmed
    void writeClipboard(text).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1000)
    })
  }, [copied, trimmed])

  // shiki's HTML output is a static span tree it generated from `code` (no
  // user HTML passes through), the sanctioned innerHTML consumption path per
  // shiki's own docs.
  const body = streamedBody !== undefined
    ? streamedBody
    : html === undefined
      ? (
        <pre className={css.plain}><code>{trimmed}</code></pre>
      )
      : (
        <div dangerouslySetInnerHTML={{ __html: html }} />
      )

  return (
    <div ref={rootRef} className={clsx(css.block, 'md-code-block', className)}>
      <div className={css.bannerWrap}>
        <div className={css.banner}>
          <div className={css.infostring}>{lang ?? 'code'}</div>
          <div className={css.action}>
            {downloadLabel !== undefined && (
              <button type="button" className={clsx(css.actionButton, css.downloadButton)} onClick={onDownload}>
                <IconDownloadOutline16 size={14} />
                {downloadLabel}
              </button>
            )}
            {runLabel !== undefined && onRun !== undefined && (
              <button type="button" className={clsx(css.actionButton, css.runButton)} onClick={onRunClick}>
                <IconPlayOutline16 size={14} />
                {runLabel}
              </button>
            )}
            <button type="button" className={clsx(css.actionButton, css.copyButton)} onClick={onCopy}>
              {copied ? <IconCheckOutline14 size={14} /> : <IconCopyOutline16 size={14} />}
              {copied ? copiedLabel : copyLabel}
            </button>
          </div>
        </div>
      </div>
      {body}
    </div>
  )
}
