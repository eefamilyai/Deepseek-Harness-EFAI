// CodeBlock: one code surface for every consumer — markdown fences, the
// run_code program body, and the details panel's raw args/output — with
// shiki highlighting for the registered grammars and an identical-geometry
// plain fallback for everything else. Chrome (language banner + copy) matches
// deepsuite `@deepseek/md` code blocks; token colors stay on `--shiki-*`.
//
// Run and Download are opt-in: callers that render standalone code (markdown,
// tool payloads) may supply an `onRun` handler and/or the two labels; fences
// rendered without them keep the exact pre-existing DOM so the pinned
// markdown fixtures do not drift.

import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import { writeClipboard } from '../clipboard.ts'
import { grammarLoadCount, highlightToHtml, subscribeGrammarLoaded } from './highlight.ts'
import css from './CodeBlock.module.css'

export interface CodeBlockProps {
  /** The source text, rendered verbatim (trailing newline trimmed for display). */
  code: string
  /** Grammar hint (markdown fence info string or a fixed caller id); unknown = plain. */
  lang?: string | undefined
  /** Extra class merged onto the wrapper (callers position; this component draws). */
  className?: string | undefined
  /** Copy-button idle label; the owner passes localized copy (this package is cordis-free, so copy arrives via props). */
  copyLabel?: string | undefined
  /** Copy-button label during the post-copy confirmation window. */
  copiedLabel?: string | undefined
  /** Run-button label. Absent hides the Run button (default fences stay copy-only). */
  runLabel?: string | undefined
  /** Download-button label. Absent hides the Download button. */
  downloadLabel?: string | undefined
  /** Invoked with the trimmed code when the user presses Run; absent hides the Run button. */
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
  // Release after the click dispatch returns; the download is already queued.
  window.setTimeout(() => { URL.revokeObjectURL(url) }, 0)
}

export function CodeBlock({
  code, lang, className,
  copyLabel = '复制', copiedLabel = '复制成功',
  runLabel, downloadLabel, onRun,
}: CodeBlockProps) {
  const trimmed = code.endsWith('\n') ? code.slice(0, -1) : code
  // Re-render when a lazy grammar finishes loading, so a fence that showed plain
  // text while its language's grammar imported picks up highlighting. The
  // snapshot value is opaque; only its change across renders drives the memo.
  const loaded = useSyncExternalStore(subscribeGrammarLoaded, grammarLoadCount, grammarLoadCount)
  const html = useMemo(() => highlightToHtml(trimmed, lang), [trimmed, lang, loaded])
  const rootRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)

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

  const onDownload = useCallback(() => {
    downloadCode(trimmed, lang)
  }, [trimmed, lang])

  const onRunClick = useCallback(() => {
    onRun?.(trimmed)
  }, [onRun, trimmed])

  const body = html === undefined
    ? (
      <pre className={css.plain}><code>{trimmed}</code></pre>
    )
    : (
  // shiki's output is a static span tree it generated from `code` (no user
  // HTML passes through), the sanctioned innerHTML consumption path per
  // shiki's own docs.
      <div dangerouslySetInnerHTML={{ __html: html }} />
    )

  return (
    <div ref={rootRef} className={clsx(css.block, 'md-code-block', className)}>
      <div className={css.bannerWrap}>
        <div className={css.banner}>
          <div className={css.infostring}>{lang ?? ''}</div>
          <div className={css.action}>
            {downloadLabel !== undefined && (
              <button type="button" className={clsx(css.actionButton, css.downloadButton)} onClick={onDownload}>
                {downloadLabel}
              </button>
            )}
            {runLabel !== undefined && onRun !== undefined && (
              <button type="button" className={clsx(css.actionButton, css.runButton)} onClick={onRunClick}>
                {runLabel}
              </button>
            )}
            <button type="button" className={clsx(css.actionButton, css.copyButton)} onClick={onCopy}>
              {copied ? copiedLabel : copyLabel}
            </button>
          </div>
        </div>
      </div>
      {body}
    </div>
  )
}
