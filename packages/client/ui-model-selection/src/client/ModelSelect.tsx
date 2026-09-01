/**
 * ModelSelect: the composer's model seat (`conversation.input.model`).
 *
 * One collapsible list, provider by provider. A provider that pools logins
 * (DeepSeek web) shows its accounts as chips plus an inline "add account" form
 * that tests the login through `addAccount` and, on success, surfaces the new
 * login as its own selectable route. Models are exactly what the host catalog
 * reports — a provider with none shows an empty state, never a guessed list.
 * A model that exposes reasoning efforts shows them as a segmented control
 * under its row. Data and submission ride the shared per-session ModelDirectory
 * (the same one the /model popup uses); a rejected action announces through the
 * shared Toast anchored to the composer card.
 */
import {
  useEffect, useId, useMemo, useRef, useState, useSyncExternalStore,
  type FormEvent, type KeyboardEvent,
} from 'react'
import clsx from 'clsx'
import type { ModelProviderGroup, ModelReasoningEffort } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconCheckOutline16, IconChevronDownOutline14, IconChevronRightOutline14,
  IconWarningOutline16, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelSelectInjected } from './slots.ts'
import css from './ModelSelect.module.css'

/** One catalog model, as its provider group carries it. */
type CatalogModel = ModelProviderGroup['models'][number]

<<<<<<< HEAD
/** One provider, its models, and the logins it pools (empty for keyed providers). */
interface ProviderView {
  /** The base route id used for model requests and account additions. */
  base: string
  /** Display name (from the base route). */
  name: string
  /** Models the host reported for this provider, in order. */
  models: readonly CatalogModel[]
  /** Pooled login ids, each already a selectable `base@account` route. */
  accounts: readonly string[]
}

/** Split a route id into its base and the pooled login it pins, if any. */
function splitRoute(id: string): { base: string; account: string } {
  const at = id.indexOf('@')
  return at === -1 ? { base: id, account: '' } : { base: id.slice(0, at), account: id.slice(at + 1) }
}

/**
 * Fold the flat provider-route groups into one entry per provider, with the
 * per-login routes collected as accounts. The base route carries the clean name
 * and the model list; account routes serve the same models under a pinned login.
 */
function groupProviders(groups: readonly ModelProviderGroup[]): ProviderView[] {
  // Insertion order is preserved by Map, which keeps providers in catalog order.
  const byBase = new Map<string, ProviderView>()
  const ensure = (base: string): ProviderView => {
    const existing = byBase.get(base)
    if (existing !== undefined) return existing
    const view: ProviderView = { base, name: base, models: [], accounts: [] }
    byBase.set(base, view)
    return view
  }
  for (const group of groups) {
    const { base, account } = splitRoute(group.id)
    const view = ensure(base)
    if (account === '') {
      view.name = group.name
      view.models = group.models
    } else {
      view.accounts = [...view.accounts, account]
      // A provider whose base route was filtered out still needs a name/models.
      if (view.models.length === 0) view.models = group.models
    }
  }
  return [...byBase.values()]
=======
/** One dynamic effort row; undefined means preserve the provider default. */
interface EffortChoice {
  key: string
  effort: string | undefined
  label: string
>>>>>>> upstream/master
}

/**
 * Render the composer model seat.
 * @param props - owner share (locked) + injected face (shared directory
 * store/verbs) + the standard locale seat.
 * @returns the trigger and, while open, the collapsible provider menu.
 */
export function ModelSelect(
  { locked, available, directory, load, select, addAccount, t }:
  ModelSelectInjected & { locked: boolean } & PropsLocale<'model'>,
) {
  const state = useSyncExternalStore(
    fn => directory.subscribe(fn),
    () => directory.getSnapshot(),
  )
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [addFor, setAddFor] = useState<string | null>(null)
  const [form, setForm] = useState({ email: '', password: '', area: '+86' })
  const [formMsg, setFormMsg] = useState<{ kind: 'error' | 'busy' | 'ok'; text: string } | null>(null)
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const lastActionRef = useRef<'load' | 'select'>('load')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const id = useId()

<<<<<<< HEAD
  const providers = useMemo(() => groupProviders(state.groups), [state.groups])
  const current = state.current
  const active = current === null ? null : splitRoute(current.provider)

  // The exact model/route/effort the trigger and selected rows read from.
  const currentModel = useMemo(() => {
    if (active === null) return undefined
    const provider = providers.find(view => view.base === active.base)
    return provider?.models.find(model => model.id === current?.model)
  }, [providers, active, current])
  const effectiveEffort = current?.reasoningEffort ?? currentModel?.reasoning?.defaultEffort
=======
  const choices = useMemo(() => state.groups.flatMap(group =>
    group.models.map(model => ({
      group,
      model,
      selection: {
        provider: group.id,
        model: model.id,
        ...model.reasoning?.defaultEffort === undefined
          ? {}
          : { reasoningEffort: model.reasoning.defaultEffort },
      } satisfies ModelSelection,
    }))), [state.groups])
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
>>>>>>> upstream/master
  const busy = state.status === 'selecting'

  const reload = (): void => { lastActionRef.current = 'load'; load() }

<<<<<<< HEAD
  useEffect(() => {
    if (available) { lastActionRef.current = 'load'; load() }
  }, [available, load])

  // Open the provider carrying the current selection so the menu lands useful.
  useEffect(() => {
    if (active !== null) setExpanded(new Set([active.base]))
  }, [active?.base])

=======
>>>>>>> upstream/master
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  if (!available) return null

  const show = (): void => { setOpen(true); reload() }
  const close = (restoreFocus = false): void => {
    setOpen(false)
    setAddFor(null)
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const toggleProvider = (base: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(base)) next.delete(base)
      else next.add(base)
      return next
    })
  }

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      if (addFor !== null) setAddFor(null)
      else close(true)
    }
  }

  const settle = (accepted: boolean): void => {
    if (accepted) { close(true); return }
    const message = directory.getSnapshot().error
    if (message !== null) {
      toastSeq.current += 1
      setToast({ seq: toastSeq.current, text: t('error.action', { message }) })
    }
  }

  /** Which route serves a model click in `view`: the live selection when it
   * belongs to this provider, otherwise the base route. */
  const routeFor = (view: ProviderView): string =>
    active !== null && active.base === view.base && current !== null ? current.provider : view.base

  const chooseModel = (view: ProviderView, model: string, effort?: string): void => {
    if (current?.provider === routeFor(view) && current.model === model
      && (effort === undefined || effectiveEffort === effort)) {
      close(true)
      return
    }
    lastActionRef.current = 'select'
    void select({ provider: routeFor(view), model, ...effort === undefined ? {} : { reasoningEffort: effort } })
      .then(settle)
  }

  const chooseAccount = (view: ProviderView, account: string): void => {
    const route = account === '' ? view.base : `${view.base}@${account}`
    if (current?.provider === route) { close(true); return }
    const model = active?.base === view.base && current !== null ? current.model : view.models[0]?.id
    if (model === undefined) return
    lastActionRef.current = 'select'
    void select({ provider: route, model }).then(settle)
  }

<<<<<<< HEAD
  const submitAccount = (view: ProviderView) => (event: FormEvent): void => {
    event.preventDefault()
    const email = form.email.trim()
    if (email.length === 0) { setFormMsg({ kind: 'error', text: t('account.needEmail') }); return }
    if (form.password.length === 0) { setFormMsg({ kind: 'error', text: t('account.needPassword') }); return }
    setFormMsg({ kind: 'busy', text: t('account.testing') })
    void addAccount(view.base, { email, password: form.password, areaCode: form.area }).then((result) => {
      if (result.ok) {
        setForm({ email: '', password: '', area: '+86' })
        setFormMsg({ kind: 'ok', text: t('account.added', { account: result.account ?? email }) })
        setAddFor(null)
      } else {
        setFormMsg({ kind: 'error', text: result.message ?? t('account.failed') })
      }
    })
=======
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
>>>>>>> upstream/master
  }

  const modelLabel = currentModel?.name ?? t('trigger.fallback')
  const activeAccount = active?.account ?? ''
  const triggerTitle = activeAccount.length > 0 ? `${modelLabel} · ${activeAccount}` : modelLabel

  return (
    <div ref={rootRef} className={css.root} onKeyDown={onRootKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-label={currentModel === undefined
          ? t('trigger.selectAria')
          : activeAccount.length > 0
            ? t('trigger.ariaEffort', { model: modelLabel, effort: activeAccount })
            : t('trigger.aria', { model: modelLabel })}
        aria-haspopup="menu"
        aria-expanded={open}
        title={triggerTitle}
        disabled={locked}
        onClick={() => { if (open) close(); else show() }}
      >
        <span className={css.triggerLabel}>{modelLabel}</span>
        {activeAccount.length > 0 && <span className={css.triggerEffort}>{activeAccount}</span>}
        <IconChevronDownOutline14 className={clsx(css.chevron, open && css.chevronOpen)} />
      </button>

      {open && (
        <div id={`${id}-menu`} className={css.menu} role="menu" aria-label={t('menu.aria')}
          aria-busy={state.status === 'loading' || busy}>
          {state.status === 'loading' && providers.length === 0 && (
            <div className={css.status}>{t('status.loading')}</div>
          )}
<<<<<<< HEAD
          {state.error !== null && lastActionRef.current === 'load' && (
            <div className={css.error}>
              <span>{t('error.action', { message: state.error })}</span>
              <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
            </div>
=======

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
                {state.groups.map((group) => {
                  const headingId = `${id}-${group.id}`
                  return (
                    <section role="group" aria-labelledby={headingId} className={css.group} key={group.id}>
                      <div className={css.groupTitle} id={headingId}>{group.name}</div>
                      {group.models.map((model) => {
                        const selected = state.current?.provider === group.id && state.current.model === model.id
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
                            onClick={() => { choose({ provider: group.id, model: model.id }) }}
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
                    </section>
                  )
                })}
              </div>
              {state.status === 'ready' && choices.length === 0 && (
                <div className={css.empty}>{t('empty.models')}</div>
              )}
            </>
>>>>>>> upstream/master
          )}
          {state.failures.map(failure => (
            <div className={css.warning} key={failure.id}>
              <span>{t('warning.groupLoad', { name: failure.name, message: failure.message })}</span>
              <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
            </div>
          ))}

          <div className={clsx(css.list, 'scrollable')}>
            {providers.map((view) => {
              const isOpen = expanded.has(view.base)
              const pools = view.accounts.length > 0
              const headingId = `${id}-${view.base}`
              return (
                <section className={css.provider} key={view.base}>
                  <button
                    type="button"
                    className={css.providerHead}
                    aria-expanded={isOpen}
                    aria-controls={headingId}
                    onClick={() => { toggleProvider(view.base) }}
                  >
<<<<<<< HEAD
                    {isOpen
                      ? <IconChevronDownOutline14 className={css.headChevron} />
                      : <IconChevronRightOutline14 className={css.headChevron} />}
                    <span className={css.providerName}>{view.name}</span>
                    <span className={css.providerMeta}>
                      {pools
                        ? (active?.base === view.base && activeAccount.length > 0 ? activeAccount : t('provider.accounts', { count: view.accounts.length }))
                        : view.models.length > 0
                          ? t('provider.models', { count: view.models.length })
                          : t('provider.noModels')}
=======
                    <span className={css.optionCopy}>
                      <span className={css.modelName}>{level.label}</span>
                    </span>
                    <span className={css.check}>
                      {effectiveEffort === level.effort ? <IconCheckOutline16 /> : null}
>>>>>>> upstream/master
                    </span>
                  </button>

                  {isOpen && (
                    <div className={css.providerBody} id={headingId}>
                      {pools && (
                        <div className={css.accounts}>
                          {view.accounts.map((account) => {
                            const on = active?.base === view.base && activeAccount === account
                            return (
                              <button
                                type="button"
                                key={account}
                                className={clsx(css.chip, on && css.chipOn)}
                                disabled={busy}
                                onClick={() => { chooseAccount(view, account) }}
                              >
                                {on ? <IconCheckOutline16 className={css.chipIcon} /> : null}
                                <span className={css.chipLabel}>{account}</span>
                              </button>
                            )
                          })}
                          <button
                            type="button"
                            className={css.chipAdd}
                            onClick={() => { setFormMsg(null); setAddFor(addFor === view.base ? null : view.base) }}
                          >
                            + {t('account.add')}
                          </button>
                        </div>
                      )}

                      {pools && addFor === view.base && (
                        <form className={css.addForm} onSubmit={submitAccount(view)}>
                          <input
                            className={css.input}
                            type="email"
                            placeholder={t('account.emailPlaceholder')}
                            value={form.email}
                            onChange={(event) => { setForm({ ...form, email: event.target.value }); setFormMsg(null) }}
                          />
                          <input
                            className={css.input}
                            type="password"
                            placeholder={t('account.passwordPlaceholder')}
                            value={form.password}
                            onChange={(event) => { setForm({ ...form, password: event.target.value }); setFormMsg(null) }}
                          />
                          {formMsg !== null && (
                            <div className={clsx(css.formMsg, formMsg.kind === 'error' && css.formErr, formMsg.kind === 'ok' && css.formOk)}>
                              {formMsg.text}
                            </div>
                          )}
                          <div className={css.addActions}>
                            <button type="submit" className={css.addTest} disabled={formMsg?.kind === 'busy'}>
                              {t('account.testAdd')}
                            </button>
                            <button type="button" className={css.addCancel} onClick={() => { setAddFor(null); setFormMsg(null) }}>
                              {t('account.cancel')}
                            </button>
                          </div>
                        </form>
                      )}

                      {view.models.length === 0 && !pools && (
                        <div className={css.empty}>{t('provider.configure')}</div>
                      )}

                      {view.models.map((model) => {
                        const selected = active?.base === view.base && current?.model === model.id
                        const efforts = model.reasoning?.efforts ?? []
                        return (
                          <div key={model.id}>
                            <button
                              type="button"
                              className={clsx(css.option, selected && css.selected)}
                              disabled={busy}
                              title={model.name}
                              onClick={() => { chooseModel(view, model.id) }}
                            >
                              <span className={css.optionCopy}>
                                <span className={css.modelName}>{model.name}</span>
                                {model.description !== undefined && (
                                  <span className={css.description}>{model.description}</span>
                                )}
                              </span>
                              <span className={css.check}>{selected ? <IconCheckOutline16 /> : null}</span>
                            </button>
                            {selected && efforts.length > 0 && (
                              <div className={css.efforts}>
                                {efforts.map((effort: ModelReasoningEffort) => (
                                  <button
                                    type="button"
                                    key={effort.id}
                                    className={clsx(css.effort, effectiveEffort === effort.id && css.effortOn)}
                                    disabled={busy}
                                    title={effort.description ?? effort.name}
                                    onClick={() => { chooseModel(view, model.id, effort.id) }}
                                  >
                                    {effort.name}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </section>
              )
            })}
            {state.status === 'ready' && providers.length === 0 && (
              <div className={css.empty}>{t('empty.models')}</div>
            )}
          </div>
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
