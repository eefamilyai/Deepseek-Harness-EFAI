/**
 * ModelSelect: the composer's named model seat (`conversation.input.model`).
 * Two-level selection per figma 496:26454's MenuDropdown: the root menu is
 * the Model / Effort row pair (label + current value + a right chevron),
 * each drilling into its own list — the provider-grouped model list over
 * the shared directory, and the effort levels. The trigger (313:14108's
 * ToggleButton) shows both: model name + effort in the caption tone.
 * Data and submission ride the SAME per-session ModelDirectory as the
 * /model popup; exact-model reasoning metadata and the selected effort come
 * from the Host rather than a client-owned vocabulary. A rejected selection
 * announces through the shared transient Toast anchored to the composer
 * card; the in-menu strip with Retry remains the catalog-load surface.
 */
import {
  useEffect, useId, useMemo, useRef, useState, useSyncExternalStore,
  type KeyboardEvent, type FocusEvent,
} from 'react'
import clsx from 'clsx'
import type { ModelReasoningEffort, ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelCatalogModel, ModelProviderGroup } from '@deepseek-ai/dsh-api-session-controller/types'
import {
  IconCheckOutline16, IconChevronDownOutline14, IconChevronRightOutline14,
  IconWarningOutline16, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelSelectInjected } from './slots.ts'
import css from './ModelSelect.module.css'

/** Which pane the dropdown shows: the two-row root or one drilled-in list. */
type Pane = 'root' | 'model' | 'effort'

/** One dynamic effort row; undefined means preserve the provider default. */
interface EffortChoice {
  key: string
  effort: string | undefined
  label: string
}

// DSH-FORK(browser): fold account-bound provider routes (`kiln-deepseek@one`,
// `kiln-deepseek@two`) under their base provider so the dropdown shows one
// provider header plus an account picker instead of one header per account.
// EXIT: upstream adopts account grouping in ModelSelect.
interface AccountChoice {
  readonly provider: string
  readonly account: string | null
}

interface MergedGroup {
  readonly baseId: string
  readonly name: string
  readonly models: readonly ModelCatalogModel[]
  readonly accounts: readonly AccountChoice[]
}

function mergeGroups(groups: readonly ModelProviderGroup[]): readonly MergedGroup[] {
  const baseById = new Map<string, ModelProviderGroup>()
  const accountsByBase = new Map<string, ModelProviderGroup[]>()
  for (const group of groups) {
    if (group.id.includes('@')) {
      const baseId = group.id.slice(0, group.id.indexOf('@'))
      const list = accountsByBase.get(baseId)
      if (list === undefined) accountsByBase.set(baseId, [group])
      else list.push(group)
    } else {
      baseById.set(group.id, group)
    }
  }

  const merged: MergedGroup[] = []
  for (const group of groups) {
    if (group.id.includes('@')) {
      // A route whose base provider is absent is not an account route; render
      // it as its own group exactly as the unmerged list would.
      if (!baseById.has(group.id.slice(0, group.id.indexOf('@')))) {
        merged.push({
          baseId: group.id,
          name: group.name,
          models: group.models,
          accounts: [{ provider: group.id, account: null }],
        })
      }
      continue
    }
    const accounts = accountsByBase.get(group.id) ?? []
    const baseChoice = { provider: group.id, account: null } satisfies AccountChoice
    merged.push({
      baseId: group.id,
      name: group.name,
      models: group.models,
      accounts: accounts.length === 0
        ? [baseChoice]
        : [baseChoice, ...accounts.map(account => ({
          provider: account.id,
          account: account.id.slice(group.id.length + 1),
        }))],
    })
  }
  return merged
}

/**
 * Render the composer model seat.
 * @param props - owner share (locked) + injected face (shared directory
 * store/verbs) + the standard locale seat.
 * @returns the trigger and, while open, the two-level menu.
 */
export function ModelSelect(
  { locked, available, directory, load, select, t }:
  ModelSelectInjected & { locked: boolean } & PropsLocale<'model'>,
) {
  const state = useSyncExternalStore(
    fn => directory.subscribe(fn),
    () => directory.getSnapshot(),
  )
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>('root')
  // The in-menu error strip serves catalog loads (its Retry re-runs the
  // load); a rejected SELECTION announces through the transient toast
  // instead, so the strip renders only while the latest failure-capable
  // action was a load.
  const lastActionRef = useRef<'load' | 'select'>('load')
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const id = useId()

  const mergedGroups = useMemo(() => mergeGroups(state.groups), [state.groups])
  // The account route each merged group currently targets, keyed by base id;
  // defaults to the account owning the current selection, else the base route.
  const [accountSelections, setAccountSelections] = useState<Readonly<Record<string, string>>>({})

  // The route each merged group targets: an explicit account pick overrides,
  // then the account owning the current selection, then the base route.
  const resolvedProvider = useMemo(() => {
    const resolved: Record<string, string> = {}
    for (const group of mergedGroups) {
      const first = group.accounts[0]?.provider ?? group.baseId
      resolved[group.baseId] = accountSelections[group.baseId]
        ?? group.accounts.find(account => account.provider === state.current?.provider)?.provider
        ?? first
    }
    return resolved
  }, [mergedGroups, accountSelections, state.current?.provider])

  // One choice per base model, resolved through the currently selected account
  // so keyboard navigation, the selected check mark, and `choose` all agree.
  const choices = useMemo(() => mergedGroups.flatMap(group =>
    group.models.map(model => ({
      group,
      model,
      selection: {
        provider: resolvedProvider[group.baseId] ?? group.baseId,
        model: model.id,
        ...model.reasoning?.defaultEffort === undefined
          ? {}
          : { reasoningEffort: model.reasoning.defaultEffort },
      } satisfies ModelSelection,
    }))), [mergedGroups, resolvedProvider])
  const selectedIndex = state.current === null
    ? -1
    : choices.findIndex(c => c.selection.provider === state.current?.provider && c.selection.model === state.current.model)
  const currentChoice = choices[selectedIndex]
  const reasoning = currentChoice?.model.reasoning
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
  const effortLabel = reasoning === undefined
    ? undefined
    : effectiveEffort === undefined
      ? t('effort.providerDefault')
      : reasoning.efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort
  const effortChoices = useMemo<readonly EffortChoice[]>(() => reasoning === undefined
    ? []
    : [
      ...reasoning.defaultEffort === undefined
        ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }]
        : [],
      ...reasoning.efforts.map((effort: ModelReasoningEffort) => ({
        key: `effort:${effort.id}`,
        effort: effort.id,
        label: effort.name,
      })),
    ], [reasoning, t])
  const busy = state.status === 'selecting'
  // DSH-FORK(browser): collapsible provider groups in the model pane, with
  // the provider owning the current selection expanded by default and every
  // other provider collapsed.
  // EXIT: upstream adopts per-provider collapse in ModelSelect.
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set())
  // True once the user has expressed a manual preference during this open;
  // until then the default collapse follows the current selection so a late
  // catalog arrival does not re-expand providers the user already collapsed.
  const manualCollapseRef = useRef(false)

  // Default collapse: every merged base group except the one owning the
  // current selection starts minimized.
  const defaultCollapsed = useMemo(() => {
    const currentBase = state.current?.provider?.split('@')[0]
    return new Set(mergedGroups.map(group => group.baseId).filter(id => id !== currentBase))
  }, [mergedGroups, state.current?.provider])

  const toggleGroup = (groupId: string): void => {
    manualCollapseRef.current = true
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }

  // While the model pane is open and no manual preference exists, keep the
  // collapse set in step with the default (groups may load after the pane
  // opens, and the current selection may change from elsewhere).
  useEffect(() => {
    if (!open || manualCollapseRef.current) return
    setCollapsedGroups((prev) => {
      const same = prev.size === defaultCollapsed.size
        && [...defaultCollapsed].every(id => prev.has(id))
      return same ? prev : defaultCollapsed
    })
  }, [open, defaultCollapsed])


  const reload = (): void => {
    lastActionRef.current = 'load'
    load()
  }

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  if (!available) return null

  const show = (): void => {
    setPane('root')
    manualCollapseRef.current = false
    setCollapsedGroups(defaultCollapsed)
    // A fresh open re-derives each group's account from the current selection.
    setAccountSelections({})
    setOpen(true)
    reload()
  }

  const close = (restoreFocus = false): void => {
    setOpen(false)
    setPane('root')
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const moveFocus = (offset: number): void => {
    const items = itemRefs.current.filter(item => item !== null)
    if (items.length === 0) return
    const active = items.findIndex(item => item === document.activeElement)
    const next = (Math.max(active, 0) + offset + items.length) % items.length
    items[next]?.focus()
  }

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      // Escape backs out of a drilled pane first, then closes.
      if (pane !== 'root') setPane('root')
      else close(true)
      return
    }
    if (!open) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget)) return
    close()
  }

  const settleSelection = (accepted: boolean): void => {
    if (accepted) {
      if (rootRef.current !== null) close(true)
      return
    }
    const message = directory.getSnapshot().error
    if (message !== null) {
      toastSeq.current += 1
      setToast({ seq: toastSeq.current, text: t('error.action', { message }) })
    }
  }

  const choose = (selection: ModelSelection): void => {
    if (state.current?.provider === selection.provider && state.current.model === selection.model) {
      close(true)
      return
    }
    lastActionRef.current = 'select'
    void select(selection).then(settleSelection)
  }

  const chooseEffort = (effort: string | undefined): void => {
    if (state.current === null) return
    if (effectiveEffort === effort) {
      close(true)
      return
    }
    const selection: ModelSelection = {
      provider: state.current.provider,
      model: state.current.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
    }
    lastActionRef.current = 'select'
    void select(selection).then(settleSelection)
  }

  const waiting = state.current === null && state.status === 'loading'
  const modelLabel = waiting
    ? t('trigger.loading')
    : currentChoice?.model.name
      ?? (state.current === null ? t('trigger.fallback') : `${state.current.provider}/${state.current.model}`)
  const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`
  const triggerAria = waiting
    ? t('trigger.loading')
    : state.current === null
      ? t('trigger.selectAria')
      : effortLabel === undefined
        ? t('trigger.aria', { model: modelLabel })
        : t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel })
  itemRefs.current = []
  let itemIndex = 0
  const itemRef = () => {
    const at = itemIndex++
    return (node: HTMLButtonElement | null) => { itemRefs.current[at] = node }
  }

  return (
    <div ref={rootRef} className={css.root} onKeyDown={onRootKeyDown} onBlur={onBlur}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-label={triggerAria}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={triggerLabel}
        disabled={locked}
        onClick={() => {
          if (open) {
            close()
          } else {
            show()
          }
        }}
      >
        <span className={css.triggerLabel}>{modelLabel}</span>
        {effortLabel !== undefined && <span className={css.triggerEffort}>{effortLabel}</span>}
        <IconChevronDownOutline14 className={clsx(css.chevron, open && css.chevronOpen)} />
      </button>

      {open && (
        <div
          id={`${id}-menu`}
          className={css.menu}
          role="menu"
          aria-label={t('menu.aria')}
          aria-busy={state.status === 'loading' || busy}
        >
          {pane === 'root' && (
            <>
              <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => { setPane('model') }}>
                <span className={css.cellLabel}>{t('menu.model')}</span>
                <span className={css.cellValue}>{modelLabel}</span>
                <IconChevronRightOutline14 className={css.cellChevron} />
              </button>
              {reasoning !== undefined && (
                <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => { setPane('effort') }}>
                  <span className={css.cellLabel}>{t('menu.effort')}</span>
                  <span className={css.cellValue}>{effortLabel}</span>
                  <IconChevronRightOutline14 className={css.cellChevron} />
                </button>
              )}
            </>
          )}

          {pane === 'model' && (
            <>
              {state.status === 'loading' && (
                <div className={css.status}>{t('status.loading')}</div>
              )}
              {state.error !== null && lastActionRef.current === 'load' && (
                <div className={css.error}>
                  <span>{t('error.action', { message: state.error })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
                </div>
              )}
              {state.failures.map(failure => (
                <div className={css.warning} key={failure.id}>
                  <span>{t('warning.groupLoad', { name: failure.name, message: failure.message })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
                </div>
              ))}
              <div className={clsx(css.groups, 'scrollable')}>
                {mergedGroups.map((group) => {
                  const headingId = `${id}-${group.baseId}`
                  const resolved = resolvedProvider[group.baseId]
                  const expanded = !collapsedGroups.has(group.baseId)
                  return (
                    <section role="group" aria-labelledby={headingId} className={css.group} key={group.baseId}>
                      <button
                        type="button"
                        className={clsx(css.groupTitle, css.groupToggle)}
                        id={headingId}
                        aria-expanded={expanded}
                        aria-controls={`${id}-group-${group.baseId}`}
                        onClick={() => { toggleGroup(group.baseId) }}
                      >
                        <IconChevronDownOutline14
                          className={clsx(css.groupChevron, !expanded && css.groupChevronCollapsed)}
                        />
                        <span className={css.groupName}>{group.name}</span>
                      </button>
                      <div id={`${id}-group-${group.baseId}`} hidden={!expanded}>
                        {group.accounts.length > 1 && (
                          <div role="group" aria-label={`${group.name} accounts`} className={css.accountPicker}>
                            {group.accounts.map((account) => {
                              const selected = resolved === account.provider
                              return (
                                <button
                                  ref={itemRef()}
                                  type="button"
                                  role="menuitemradio"
                                  aria-checked={selected}
                                  className={clsx(css.accountOption, selected && css.selected)}
                                  key={account.provider}
                                  disabled={busy}
                                  onClick={() => { setAccountSelections(prev => ({ ...prev, [group.baseId]: account.provider })) }}
                                >
                                  <span className={css.accountLabel}>{account.account === null ? group.name : account.account}</span>
                                  <span className={css.accountCheck}>
                                    {selected ? <IconCheckOutline16 /> : null}
                                  </span>
                                </button>
                              )
                            })}
                          </div>
                        )}
                        {group.models.map((model) => {
                          const selected = state.current?.provider === resolved && state.current?.model === model.id
                          return (
                            <button
                              ref={itemRef()}
                              type="button"
                              role="menuitemradio"
                              aria-checked={selected}
                              className={clsx(css.option, selected && css.selected)}
                              key={model.id}
                              title={model.name}
                              disabled={busy}
                              onClick={() => { choose({ provider: resolved ?? group.baseId, model: model.id }) }}
                            >
                              <span className={css.optionCopy}>
                                <span className={css.modelName}>{model.name}</span>
                              </span>
                              <span className={css.check}>
                                {selected ? <IconCheckOutline16 /> : null}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    </section>
                  )
                })}
              </div>
              {state.status === 'ready' && choices.length === 0 && (
                <div className={css.empty}>{t('empty.models')}</div>
              )}
            </>
          )}

          {pane === 'effort' && (
            <>
              {state.error !== null && lastActionRef.current === 'load' && (
                <div className={css.error}>
                  <span>{t('error.action', { message: state.error })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('action.reload')}</button>
                </div>
              )}
              {effortChoices.length === 0
                ? <div className={css.empty}>{t('empty.efforts')}</div>
                : effortChoices.map(level => (
                  <button
                    ref={itemRef()}
                    type="button"
                    role="menuitemradio"
                    aria-checked={effectiveEffort === level.effort}
                    className={clsx(css.option, effectiveEffort === level.effort && css.selected)}
                    key={level.key}
                    disabled={busy}
                    onClick={() => { chooseEffort(level.effort) }}
                  >
                    <span className={css.optionCopy}>
                      <span className={css.modelName}>{level.label}</span>
                    </span>
                    <span className={css.check}>
                      {effectiveEffort === level.effort ? <IconCheckOutline16 /> : null}
                    </span>
                  </button>
                ))}
            </>
          )}
        </div>
      )}
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutline16 />}
          anchor={rootRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null}
          onDone={() => { setToast(null) }}
        />
      )}
    </div>
  )
}
