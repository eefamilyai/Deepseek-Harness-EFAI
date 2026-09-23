/**
 * Advanced Settings: raw JSON editor for every registered settings namespace.
 *
 * Namespace selection is rendered as custom rounded cards instead of a native
 * select: native option menus ignore the app theme (white text on white is the
 * classic failure), and cards give each namespace a stable hover tooltip that
 * explains what it owns.
 */
import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientRemote, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import css from './AdvancedSection.module.css'

/** Short descriptions for namespaces the web UI commonly serves. */
const NAMESPACE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'agent-loop': 'Controls how the agent loop runs: budgets, retries, and loop policy.',
  'agent-presets': 'Stored agent presets and the default preset selection.',
  'bash': 'Local Bash shell tool configuration.',
  'llm-deepseek': 'DeepSeek official API connection, model catalog, and retry policy.',
  'llm-pi-ai': 'Generic pi-ai provider routes, custom endpoints, and model overrides.',
  'kernel': 'Run Python in a persistent kernel as the way to act on this machine.'
    + ' While on, the shell, filesystem, search, and background-job tools are replaced by'
    + ' function calls inside that namespace. Takes effect on restart.',
  'llm-kiln': 'Kiln multi-provider bridge, including the DeepSeek free web credentials.',
  'locale': 'UI language and locale.',
  'permission': 'Permission gates and preset policies.',
  'pwsh': 'Local PowerShell shell tool configuration.',
  'shell': 'Shell execution environment settings.',
  'ui-conversation': 'Conversation UI behavior such as composer and chat settings.',
  'ui-theme': 'Theme and appearance settings.',
  'ui-onboarding': 'Onboarding flow state.',
  'web-search-deepseek': 'DeepSeek-backed web search provider settings.',
}

/** Minimal transport face this section needs. */
export type AdvancedSectionInjected = {
  settings: ClientRemote['settings']
}

export type AdvancedSectionProps = SettingsSectionOwnerProps & AdvancedSectionInjected

function describeNamespace(ns: string): string {
  const known = NAMESPACE_DESCRIPTIONS[ns]
  if (known !== undefined) return known
  // Derive a readable sentence for unknown namespaces: dashes become spaces.
  return `Settings owned by the "${ns}" plugin.`
}

export function AdvancedSection({ settings }: AdvancedSectionProps) {
  const [views, setViews] = useState<SettingsNamespaceView[]>([])
  const [selectedNs, setSelectedNs] = useState<string>('')
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    void Promise.resolve(settings.describe()).then((result) => {
      if (!alive) return
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      const namespaces = result.value.namespaces
      setViews(namespaces)
      const first = namespaces[0]?.ns ?? ''
      setSelectedNs(first)
      setDraft(first === '' ? '' : JSON.stringify(namespaces[0]?.value ?? null, null, 2))
    })
    return () => { alive = false }
  }, [settings])

  const selected = useMemo(
    () => views.find(view => view.ns === selectedNs),
    [views, selectedNs],
  )

  const onSelect = (ns: string): void => {
    setSelectedNs(ns)
    const view = views.find(candidate => candidate.ns === ns)
    setDraft(JSON.stringify(view?.value ?? null, null, 2))
    setError(null)
    setNotice(null)
  }

  const save = async (): Promise<void> => {
    const view = selected
    if (view === undefined) return
    let section: unknown
    try {
      section = JSON.parse(draft)
    } catch (parseError) {
      setError(`Invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`)
      setNotice(null)
      return
    }
    if (typeof section !== 'object' || section === null || Array.isArray(section)) {
      setError('Settings sections must be JSON objects ({}), not arrays or scalar values.')
      setNotice(null)
      return
    }
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const result = await settings.replace(
        view.ns,
        section as Record<string, JsonValue>,
        view.revision,
      )
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      const updated = result.value
      setViews(prev => prev.map(existing => existing.ns === updated.ns ? updated : existing))
      setDraft(JSON.stringify(updated.value ?? null, null, 2))
      setNotice(`Saved ${updated.ns}.`)
    } catch (writeError) {
      setError(writeError instanceof Error ? writeError.message : String(writeError))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={css.root}>
      <p className={css.intro}>
        Raw access to every settings namespace. Secret values are redacted on read;
        enter a replacement value to update one, or omit a secret to preserve it.
      </p>

      {error !== null && <div className={css.error} role="alert">{error}</div>}
      {notice !== null && <div className={css.notice} role="status">{notice}</div>}

      <div className={css.group}>
        <span className={css.groupLabel}>Namespace</span>
        <div className={css.namespaceGrid} role="listbox" aria-label="Settings namespace">
          {views.map(view => (
            <Tooltip key={view.ns} label={describeNamespace(view.ns)} side="top" maxWidth={260}>
              <button
                type="button"
                role="option"
                aria-selected={view.ns === selectedNs}
                className={clsx(css.namespaceCard, view.ns === selectedNs && css.namespaceCardActive)}
                onClick={() => { onSelect(view.ns) }}
              >
                <span className={css.namespaceName}>{view.ns}</span>
                <span className={css.namespaceBadge}>{view.applies === 'live' ? 'live' : 'restart'}</span>
              </button>
            </Tooltip>
          ))}
        </div>
      </div>

      <label className={css.label}>
        Section value (JSON)
        <textarea
          className={css.textarea}
          value={draft}
          onChange={(event) => { setDraft(event.target.value) }}
          spellCheck={false}
        />
      </label>

      <div className={css.actions}>
        <Button
          variant="primary"
          size="sm"
          disabled={saving || selected === undefined}
          onClick={() => { void save() }}
        >
          {saving ? 'Saving…' : 'Save section'}
        </Button>
        {selected !== undefined && (
          <span className={css.revision}>revision {selected.revision}</span>
        )}
      </div>
    </div>
  )
}
