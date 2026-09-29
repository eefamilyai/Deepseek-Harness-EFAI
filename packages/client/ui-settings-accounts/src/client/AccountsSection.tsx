/**
 * The Accounts settings section: add a DeepSeek web login, see every pooled
 * login, and repair one in place.
 *
 * Three things live here, and they answer one question each. The add form
 * answers "how do I get a login in". The list answers "what do I actually
 * have" — one expandable card per login, showing the identity rows the provider
 * reports, including the device each login presents from. The buttons on a card
 * answer "fix this one", without hand-editing ds_config.json or deleting a
 * directory by hand.
 *
 * The debug log is the fourth answer: what happened, in order, attributed to
 * the account it happened to. That attribution is the point — two logins
 * running at once interleave on the wire, and a line that names its account is
 * what makes them separable again.
 *
 * Every Host call is wrapped, because a rejected call is the one outcome this
 * section must never render as "nothing here". A Host that predates a Remote
 * method rejects with a TypeError rather than answering a result, and an
 * unhandled rejection would leave the list and the log both blank with no
 * explanation on screen — indistinguishable from genuinely having no accounts.
 * The failure is therefore caught and shown, as its own message.
 *
 * Nothing here knows what an account is beyond the shapes the wire takes, so a
 * second account-pooling provider appears without a change to this file.
 */
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Checkbox, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import css from './AccountsSection.module.css'

/** How often the log panel asks for entries it has not seen yet. */
const LOG_POLL_MS = 2000

/** One label/value identity row a provider reports about an account. */
export interface AccountsSectionField {
  /** Human-readable field name, e.g. `X device id`. */
  readonly label: string
  /** The field's value. Never a credential. */
  readonly value: string
}

/** One pooled login, as this section lists and expands it. */
export interface AccountsSectionAccount {
  /** The login id, as the provider names it; its slug for an orphan. */
  readonly id: string
  /**
   * The browser-profile slug this login's identity lives under.
   *
   * The handle that always exists: a configured row has an id and a slug, while
   * an orphan has only the slug, because the id it was configured under is
   * exactly what is gone.
   */
  readonly slug: string
  /** The provider route that pools this login. */
  readonly provider: string
  /** A short human label for the row. */
  readonly label: string
  /** Whether the login is currently in the provider's account pool. */
  readonly configured: boolean
  /** Provider-reported identity rows, in display order. */
  readonly fields: readonly AccountsSectionField[]
}

/** One operator-facing debug line about account activity. */
export interface AccountsSectionLogEntry {
  /** Monotonic sequence number, unique within one provider. */
  readonly seq: number
  /** Unix seconds the event was recorded. */
  readonly at: number
  /** The account the event is attributed to. */
  readonly account: string
  /** Short event name, e.g. `login`, `relogin`, `reprofile`. */
  readonly event: string
  /** Severity: `info`, `warn`, or `error`. */
  readonly level: string
  /** A plain human sentence; never a credential. */
  readonly detail: string
}

/** The outcome of one repair on one account. */
export interface AccountsSectionOpResult {
  /** Whether the repair succeeded. */
  readonly ok: boolean
  /** The account repaired, when the id resolved. */
  readonly account?: string
  /** A plain failure reason, on failure. */
  readonly message?: string
}

/** Injected business face: the Host calls this section makes. */
export interface AccountsSectionInjected {
  /**
   * Read the provider routes that accept new accounts.
   * @returns the routes, or undefined when the read failed.
   */
  listProviders: () => Promise<readonly string[] | undefined>
  /**
   * Test one login and, on success, add it.
   * @param provider - the provider route that pools logins.
   * @param account - the login to test.
   * @returns the added account, or a failure reason.
   */
  addAccount: (
    provider: string,
    account: { email?: string; mobile?: string; area_code?: string; password: string },
  ) => Promise<{ ok: true; account?: string } | { ok: false; message: string }>
  /**
   * Read every login the provider pools, configured or not.
   * @param provider - the provider route that pools logins.
   * @returns the rows, or undefined when the read failed.
   */
  listAccounts: (provider: string) => Promise<readonly AccountsSectionAccount[] | undefined>
  /**
   * Re-authenticate one login, refreshing the credentials it serves with.
   * @param provider - the provider route that pools logins.
   * @param account - the login id to re-authenticate.
   * @returns whether the login now works, or a plain reason it does not.
   */
  reloginAccount: (provider: string, account: string) => Promise<AccountsSectionOpResult>
  /**
   * Replace one login's browser identity, so it presents as a new device.
   * @param provider - the provider route that pools logins.
   * @param account - the login id to re-profile.
   * @returns whether a fresh identity is in place, or a plain reason it is not.
   */
  reprofileAccount: (provider: string, account: string) => Promise<AccountsSectionOpResult>
  /**
   * Forget one login, or one orphaned identity, from the provider's list.
   *
   * The repair for an entry that should not be there at all. `account` is empty
   * for an orphan — the login id it was configured under is exactly what is
   * gone, so its slug is the only handle left. The browser profile survives
   * unless `purge` is set.
   * @param provider - the provider route that pools logins.
   * @param account - the login id to forget; '' when only a slug is known.
   * @param slug - the profile slug, which is all an orphan carries.
   * @param purge - also delete the browser profile.
   * @returns whether the entry is gone, or a plain reason it is not.
   */
  removeAccount: (
    provider: string,
    account: string,
    slug: string,
    purge: boolean,
  ) => Promise<AccountsSectionOpResult>
  /**
   * Read the debug lines recorded since a sequence number.
   * @param provider - the provider route that pools logins.
   * @param since - return only entries with a higher sequence number.
   * @returns the entries, or undefined when the read failed.
   */
  accountLog: (provider: string, since: number) => Promise<readonly AccountsSectionLogEntry[] | undefined>
}

/** Full component props: runtime share + locale seat + injected face. */
export type AccountsSectionComponentProps =
  PropsRuntime<'settings.section'> & PropsLocale<'accounts'> & AccountsSectionInjected

/** Which identifier the form is filling in. */
type IdentifierKind = 'email' | 'mobile'

/** Which repair a row is running, so only that row shows as busy. */
type RepairKind = 'relogin' | 'reprofile' | 'remove'

/**
 * A failure to show the operator, split into a headline and the detail.
 * `title` is localized copy; `detail` is whatever the failing call said, which
 * is a Host message and therefore shown verbatim.
 */
interface Failure {
  readonly title: string
  readonly detail: string
}

/**
 * Join class names, skipping the falsy ones.
 *
 * A local joiner rather than a dependency: this section composes at most three
 * classes at a time, which is less than the cost of another package edge.
 * @param parts - class names, or a falsy value to skip one.
 * @returns the space-joined class list.
 */
function cx(...parts: readonly (string | false | undefined)[]): string {
  return parts.filter(part => typeof part === 'string' && part.length > 0).join(' ')
}

/**
 * Describe a rejected call in one line.
 *
 * A rejection carries no result, so the only thing to report is the thrown
 * value itself. An `Error` has a message; anything else is stringified, and a
 * value that cannot even be stringified degrades to its type tag rather than
 * throwing out of the error path.
 * @param cause - the value a call rejected with.
 * @returns a printable description.
 */
function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  try {
    return String(cause)
  } catch {
    return Object.prototype.toString.call(cause)
  }
}

/**
 * Render one log timestamp as a fixed `HH:MM:SS` clock reading.
 * @param at - Unix seconds.
 * @returns the clock reading.
 */
function clock(at: number): string {
  const when = new Date(at * 1000)
  const part = (value: number): string => String(value).padStart(2, '0')
  return `${part(when.getHours())}:${part(when.getMinutes())}:${part(when.getSeconds())}`
}

/**
 * The severity class for one log line.
 * @param level - the entry's severity.
 * @returns the CSS module class name, or the empty string for `info`.
 */
function levelClass(level: string): string {
  if (level === 'error') return css.logError ?? ''
  if (level === 'warn') return css.logWarn ?? ''
  return ''
}

/**
 * Render one failure banner.
 * @param failure - the failure to show.
 * @returns the banner element tree.
 */
function FailureBanner({ failure }: { failure: Failure }): ReactNode {
  return (
    <div className={cx(css.banner, css.bannerError)} role="alert">
      <span className={css.bannerTitle}>{failure.title}</span>
      {failure.detail.length > 0 && <span className={css.bannerText}>{failure.detail}</span>}
    </div>
  )
}

/**
 * Render the Accounts section.
 * @param props - composed slot props.
 * @returns the section element tree.
 */
export function AccountsSection({
  t,
  listProviders,
  addAccount,
  listAccounts,
  reloginAccount,
  reprofileAccount,
  removeAccount,
  accountLog,
}: AccountsSectionComponentProps) {
  const [providers, setProviders] = useState<readonly string[]>()
  const [providersFailure, setProvidersFailure] = useState<Failure>()
  const [kind, setKind] = useState<IdentifierKind>('email')
  const [email, setEmail] = useState('')
  const [mobile, setMobile] = useState('')
  const [areaCode, setAreaCode] = useState('+86')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const [done, setDone] = useState<string>()

  const [rows, setRows] = useState<readonly AccountsSectionAccount[]>()
  const [rowsFailure, setRowsFailure] = useState<Failure>()
  const [expanded, setExpanded] = useState<readonly string[]>([])
  // Rows the operator has explicitly marked to lose their browser profile with
  // the removal. Kept per row and defaulting to empty: deleting a profile cannot
  // be undone, so it is only ever the answer to a deliberate tick, never a
  // default the confirmation dialog can imply.
  const [purgeIds, setPurgeIds] = useState<readonly string[]>([])
  const [busy, setBusy] = useState<{ id: string; op: RepairKind }>()
  const [outcome, setOutcome] = useState<string>()

  const [entries, setEntries] = useState<readonly AccountsSectionLogEntry[]>([])
  const [logFailure, setLogFailure] = useState<Failure>()
  // The last sequence number folded in. A poll asks for what is newer than this,
  // so entries are appended once and never re-read.
  const sinceRef = useRef(0)

  const loadProviders = useCallback(async (): Promise<void> => {
    try {
      const routes = await listProviders()
      if (routes === undefined) {
        setProvidersFailure({ title: t('accounts.loadError'), detail: '' })
        return
      }
      setProvidersFailure(undefined)
      setProviders(routes)
    } catch (cause) {
      setProvidersFailure({ title: t('accounts.loadError'), detail: describe(cause) })
    }
  }, [listProviders, t])

  const loadRows = useCallback(async (provider: string): Promise<void> => {
    try {
      const next = await listAccounts(provider)
      if (next === undefined) {
        setRowsFailure({ title: t('accounts.list.loadError'), detail: '' })
        return
      }
      setRowsFailure(undefined)
      setRows(next)
    } catch (cause) {
      setRowsFailure({ title: t('accounts.list.loadError'), detail: describe(cause) })
    }
  }, [listAccounts, t])

  useEffect(() => { void loadProviders() }, [loadProviders])

  const provider = providers?.[0]

  useEffect(() => {
    if (provider === undefined) return
    void loadRows(provider)
  }, [provider, loadRows])

  // A poll can still be in flight when the effect below re-runs, because its
  // dependency identity is not stable across renders. Without this guard the
  // second poll reads the same cursor and fetches the same batch again, so one
  // action renders as several identical rows.
  const inFlightRef = useRef(false)

  const poll = useCallback(async (): Promise<void> => {
    if (provider === undefined) return
    if (inFlightRef.current) return
    inFlightRef.current = true
    try {
      const fresh = await accountLog(provider, sinceRef.current)
      if (fresh === undefined) {
        setLogFailure({ title: t('accounts.log.loadError'), detail: '' })
        return
      }
      setLogFailure(undefined)
      if (fresh.length === 0) return
      const last = fresh[fresh.length - 1]
      if (last !== undefined) sinceRef.current = Math.max(sinceRef.current, last.seq)
      // Fold by sequence number rather than by arrival. A batch may be delivered
      // more than once when two polls share a cursor, and the sequence is the
      // only identity an entry has -- appending blindly both duplicates the row
      // and gives React two children with one key.
      setEntries((previous) => {
        const seen = new Set(previous.map(entry => entry.seq))
        const add = fresh.filter(entry => !seen.has(entry.seq))
        return add.length === 0 ? previous : [...previous, ...add]
      })
    } catch (cause) {
      setLogFailure({ title: t('accounts.log.loadError'), detail: describe(cause) })
    } finally {
      inFlightRef.current = false
    }
  }, [provider, accountLog, t])

  useEffect(() => {
    if (provider === undefined) return undefined
    void poll()
    const timer = setInterval(() => { void poll() }, LOG_POLL_MS)
    return () => { clearInterval(timer) }
  }, [provider, poll])

  const canSubmit = provider !== undefined && !pending

  const submit = useCallback(async (): Promise<void> => {
    if (provider === undefined) return
    const identifier = kind === 'email' ? email.trim() : mobile.trim()
    if (identifier.length === 0) {
      setDone(undefined)
      setError(t('accounts.needIdentifier'))
      return
    }
    if (password.length === 0) {
      setDone(undefined)
      setError(t('accounts.needPassword'))
      return
    }
    setPending(true)
    setError(undefined)
    setDone(undefined)
    const account = kind === 'email'
      ? { email: identifier, password }
      : { mobile: identifier, area_code: areaCode.trim() || '+86', password }
    let result: { ok: true; account?: string } | { ok: false; message: string }
    try {
      result = await addAccount(provider, account)
    } catch (cause) {
      setPending(false)
      // Clear the secret from component state before rendering the outcome.
      setPassword('')
      setError(describe(cause))
      return
    }
    setPending(false)
    setPassword('')
    if (!result.ok) {
      setError(result.message)
      return
    }
    setEmail('')
    setMobile('')
    setDone(t('accounts.success'))
    await Promise.all([loadRows(provider), poll()])
  }, [provider, kind, email, mobile, areaCode, password, addAccount, loadRows, poll, t])

  const toggle = useCallback((id: string): void => {
    setExpanded(previous => previous.includes(id)
      ? previous.filter(entry => entry !== id)
      : [...previous, id])
  }, [])

  const repair = useCallback(async (account: AccountsSectionAccount, op: RepairKind): Promise<void> => {
    if (provider === undefined) return
    setBusy({ id: account.id, op })
    setOutcome(undefined)
    let result: AccountsSectionOpResult
    try {
      result = op === 'relogin'
        ? await reloginAccount(provider, account.id)
        : await reprofileAccount(provider, account.id)
    } catch (cause) {
      setBusy(undefined)
      setOutcome(describe(cause))
      return
    }
    setBusy(undefined)
    setOutcome(result.ok
      ? t(op === 'relogin' ? 'accounts.relogin.ok' : 'accounts.reprofile.ok')
      : result.message ?? t('accounts.list.loadError'))
    await Promise.all([loadRows(provider), poll()])
  }, [provider, reloginAccount, reprofileAccount, loadRows, poll, t])

  /**
   * Forget one row, after the operator confirms it.
   *
   * A configured row is addressed by its account id; an orphaned one carries no
   * id at all -- the login it was configured under is exactly what is gone -- so
   * its slug is the only handle, and the same slug names its identity record and
   * its profile directory.
   *
   * The confirmation is a browser `confirm` because the removal is destructive.
   * It does NOT carry the purge choice: a dialog button answers "go ahead", and
   * reading its OK as "and delete the browser profile too" is exactly how an
   * irreversible deletion becomes the default. The purge answer is the row's own
   * tick, set deliberately before Remove is pressed -- so a cancelled dialog
   * cancels the removal, and a bare OK removes only the config slot.
   */
  const remove = useCallback(async (account: AccountsSectionAccount): Promise<void> => {
    if (provider === undefined) return
    const wantsPurge = purgeIds.includes(account.id)
    const prompt = wantsPurge
      ? `${t('accounts.remove.confirm')}\n\n${t('accounts.remove.purgeHint')}`
      : t('accounts.remove.confirm')
    if (!window.confirm(prompt)) return
    setBusy({ id: account.id, op: 'remove' })
    setOutcome(undefined)
    let result: AccountsSectionOpResult
    try {
      // An orphan's client id IS its slug, but its config slot is gone by
      // definition. Passing that id would ask the Host to delete a slot that no
      // longer exists, turning a valid removal into a refusal.
      const id = account.configured ? account.id : ''
      result = await removeAccount(provider, id, account.slug, wantsPurge)
    } catch (cause) {
      setBusy(undefined)
      setOutcome(describe(cause))
      return
    }
    setBusy(undefined)
    setOutcome(result.ok ? t('accounts.remove.ok') : result.message ?? t('accounts.list.loadError'))
    // The row is gone, so its purge answer no longer means anything; keeping it
    // would silently pre-arm the next row that reused the id.
    setPurgeIds((previous) => previous.filter((id) => id !== account.id))
    await Promise.all([loadRows(provider), poll()])
  }, [provider, removeAccount, loadRows, poll, t, purgeIds])

  return (
    <div className={css.section}>
      <p className={css.intro}>{t('accounts.intro')}</p>
      {providersFailure !== undefined && <FailureBanner failure={providersFailure} />}
      {error !== undefined && <FailureBanner failure={{ title: error, detail: '' }} />}
      {done !== undefined && (
        <div className={cx(css.banner, css.bannerNotice)} role="status">
          <span className={css.bannerTitle}>{done}</span>
        </div>
      )}

      {providers !== undefined && providers.length === 0 && (
        <p className={css.hint}>{t('accounts.noProviders')}</p>
      )}

      {provider !== undefined && (
        <section className={css.card}>
          <div className={css.cardHead}>
            <h3 className={css.cardTitle}>{t('accounts.add.title')}</h3>
          </div>
          <div className={css.group}>
            <div className={css.field}>
              <span className={css.label}>{t('accounts.provider.label')}</span>
              <span className={css.staticProvider}>{provider}</span>
              <span className={css.hint}>{t('accounts.provider.hint')}</span>
            </div>

            <div className={css.field}>
              <span className={css.label}>
                <span className={css.tabs}>
                  <button
                    type="button"
                    className={css.tab}
                    aria-pressed={kind === 'email'}
                    onClick={() => { setKind('email') }}
                  >
                    {t('accounts.email.label')}
                  </button>
                  <button
                    type="button"
                    className={css.tab}
                    aria-pressed={kind === 'mobile'}
                    onClick={() => { setKind('mobile') }}
                  >
                    {t('accounts.mobile.label')}
                  </button>
                </span>
              </span>
              {kind === 'email'
                ? (
                  <Input
                    type="email"
                    autoComplete="username"
                    placeholder={t('accounts.email.placeholder')}
                    value={email}
                    disabled={pending}
                    onChange={(event) => { setEmail(event.target.value) }}
                  />
                )
                : (
                  <div className={css.mobileRow}>
                    <span className={css.areaCode}>
                      <Input
                        aria-label={t('accounts.areaCode.label')}
                        placeholder="+86"
                        value={areaCode}
                        disabled={pending}
                        onChange={(event) => { setAreaCode(event.target.value) }}
                      />
                    </span>
                    <Input
                      type="tel"
                      autoComplete="tel"
                      placeholder={t('accounts.mobile.placeholder')}
                      value={mobile}
                      disabled={pending}
                      onChange={(event) => { setMobile(event.target.value) }}
                    />
                  </div>
                )}
            </div>

            <div className={css.field}>
              <span className={css.label}>{t('accounts.password.label')}</span>
              <Input
                type="password"
                autoComplete="current-password"
                placeholder={t('accounts.password.placeholder')}
                value={password}
                disabled={pending}
                onChange={(event) => { setPassword(event.target.value) }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submit()
                }}
              />
            </div>

            <div className={css.actions}>
              <Button
                variant="primary"
                disabled={!canSubmit}
                onClick={() => { void submit() }}
              >
                {pending ? t('accounts.submitting') : t('accounts.submit')}
              </Button>
            </div>
          </div>
        </section>
      )}

      {provider !== undefined && (
        <section className={css.card}>
          <div className={css.cardHead}>
            <h3 className={css.cardTitle}>{t('accounts.list.title')}</h3>
            {rows !== undefined && rows.length > 0 && (
              <span className={css.badge}>
                {t('accounts.list.count', { count: rows.length })}
              </span>
            )}
            <span className={css.cardSpacer} />
            <Button size="sm" onClick={() => { void loadRows(provider) }}>
              {t('accounts.list.refresh')}
            </Button>
          </div>
          <p className={css.cardHint}>{t('accounts.list.hint')}</p>
          {rowsFailure !== undefined && <FailureBanner failure={rowsFailure} />}
          {outcome !== undefined && (
            <div className={cx(css.banner, css.bannerNotice)} role="status">
              <span className={css.bannerTitle}>{outcome}</span>
            </div>
          )}

          {rows !== undefined && rows.length === 0 && (
            <p className={css.empty}>{t('accounts.list.empty')}</p>
          )}

          <div className={css.rows}>
            {rows?.map((row) => {
              const open = expanded.includes(row.id)
              const running = busy?.id === row.id ? busy.op : undefined
              return (
                <div key={row.id} className={cx(css.row, open && css.rowOpen)}>
                  <div className={css.rowHead}>
                    <button
                      type="button"
                      className={css.rowToggle}
                      aria-expanded={open}
                      onClick={() => { toggle(row.id) }}
                    >
                      <span className={css.chevron} aria-hidden="true" />
                      <span className={cx(
                        css.statusDot,
                        row.configured ? css.statusOn : css.statusOff,
                      )}
                      />
                      <span className={css.rowLabel}>{row.label}</span>
                      <span className={css.rowMeta}>
                        <span className={cx(css.badge, !row.configured && css.badgeOrphan)}>
                          {row.configured ? t('accounts.list.configured') : t('accounts.list.orphan')}
                        </span>
                      </span>
                    </button>
                    <div className={css.rowActions}>
                      <Button
                        size="sm"
                        disabled={running !== undefined || !row.configured}
                        title={row.configured ? undefined : t('accounts.list.orphanHint')}
                        onClick={() => { void repair(row, 'relogin') }}
                      >
                        {running === 'relogin' ? t('accounts.relogin.busy') : t('accounts.relogin')}
                      </Button>
                      <Button
                        size="sm"
                        title={row.configured ? t('accounts.reprofile.warn') : t('accounts.list.orphanHint')}
                        disabled={running !== undefined || !row.configured}
                        onClick={() => { void repair(row, 'reprofile') }}
                      >
                        {running === 'reprofile' ? t('accounts.reprofile.busy') : t('accounts.reprofile')}
                      </Button>
                      <Button
                        size="sm"
                        className={css.danger}
                        title={t('accounts.remove.warn')}
                        disabled={running !== undefined}
                        onClick={() => { void remove(row) }}
                      >
                        {running === 'remove' ? t('accounts.remove.busy') : t('accounts.remove')}
                      </Button>
                    </div>
                  </div>
                  {open && (
                    <div className={css.fields}>
                      <span className={css.fieldsHead}>{t('accounts.fields.title')}</span>
                      {!row.configured && (
                        <span className={css.hint}>{t('accounts.list.orphanHint')}</span>
                      )}
                      {row.fields.length === 0
                        ? <span className={css.hint}>{t('accounts.fields.empty')}</span>
                        : (
                          <div className={css.fieldsGrid}>
                            {row.fields.map(field => (
                              <Fragment key={field.label}>
                                <span className={css.fieldLabel}>{field.label}</span>
                                <span className={css.fieldValue}>{field.value}</span>
                              </Fragment>
                            ))}
                          </div>
                        )}
                      <Checkbox
                        checked={purgeIds.includes(row.id)}
                        onChange={(next) => {
                          setPurgeIds((previous) => next
                            ? (previous.includes(row.id) ? previous : [...previous, row.id])
                            : previous.filter((id) => id !== row.id))
                        }}
                        label={t('accounts.remove.purge')}
                        title={t('accounts.remove.purgeHint')}
                      />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}

      {provider !== undefined && (
        <section className={css.card}>
          <div className={css.cardHead}>
            <h3 className={css.cardTitle}>{t('accounts.log.title')}</h3>
            {entries.length > 0 && (
              <span className={css.badge}>
                {t('accounts.log.count', { count: entries.length })}
              </span>
            )}
            <span className={css.cardSpacer} />
            <Button size="sm" disabled={entries.length === 0} onClick={() => { setEntries([]) }}>
              {t('accounts.log.clear')}
            </Button>
          </div>
          <p className={css.cardHint}>{t('accounts.log.hint')}</p>
          {logFailure !== undefined && <FailureBanner failure={logFailure} />}
          {entries.length === 0
            ? <p className={css.empty}>{t('accounts.log.empty')}</p>
            : (
              <div className={css.log} role="log">
                {entries.map(entry => (
                  <div key={entry.seq} className={cx(css.logRow, levelClass(entry.level))}>
                    <div className={css.logMeta}>
                      <span className={css.logTime}>{clock(entry.at)}</span>
                      <span className={css.logEvent}>{entry.event}</span>
                      <span className={css.logAccount}>{entry.account}</span>
                    </div>
                    {entry.detail !== '' && <span className={css.logDetail}>{entry.detail}</span>}
                  </div>
                ))}
              </div>
            )}
        </section>
      )}
    </div>
  )
}
