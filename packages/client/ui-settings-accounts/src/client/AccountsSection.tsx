/**
 * The Accounts settings section: add a DeepSeek web login, see every pooled
 * login, and repair one in place.
 *
 * Three things live here, and they answer one question each. The add form
 * answers "how do I get a login in". The list answers "what do I actually
 * have" — one expandable row per login, showing the identity rows the provider
 * reports, including the device each login presents from. The buttons on a row
 * answer "fix this one", without hand-editing ds_config.json or deleting a
 * directory by hand.
 *
 * The debug log is the fourth answer: what happened, in order, attributed to
 * the account it happened to. That attribution is the point — two logins
 * running at once interleave on the wire, and a line that names its account is
 * what makes them separable again.
 *
 * Nothing here knows what an account is beyond the shapes the wire takes, so a
 * second account-pooling provider appears without a change to this file.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
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
  /** The login id, as the provider names it. */
  readonly id: string
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
type RepairKind = 'relogin' | 'reprofile'

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
 * @returns the CSS module class name.
 */
function levelClass(level: string): string {
  if (level === 'error') return css.logError ?? ''
  if (level === 'warn') return css.logWarn ?? ''
  return css.logEntry ?? ''
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
  accountLog,
}: AccountsSectionComponentProps) {
  const [providers, setProviders] = useState<readonly string[]>()
  const [loadError, setLoadError] = useState(false)
  const [kind, setKind] = useState<IdentifierKind>('email')
  const [email, setEmail] = useState('')
  const [mobile, setMobile] = useState('')
  const [areaCode, setAreaCode] = useState('+86')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const [done, setDone] = useState<string>()

  const [rows, setRows] = useState<readonly AccountsSectionAccount[]>()
  const [rowsError, setRowsError] = useState(false)
  const [expanded, setExpanded] = useState<readonly string[]>([])
  const [busy, setBusy] = useState<{ id: string; op: RepairKind }>()
  const [outcome, setOutcome] = useState<string>()

  const [entries, setEntries] = useState<readonly AccountsSectionLogEntry[]>([])
  // The last sequence number folded in. A poll asks for what is newer than this,
  // so entries are appended once and never re-read.
  const sinceRef = useRef(0)

  const loadProviders = useCallback(async (): Promise<void> => {
    const routes = await listProviders()
    if (routes === undefined) {
      setLoadError(true)
      return
    }
    setLoadError(false)
    setProviders(routes)
  }, [listProviders])

  const loadRows = useCallback(async (provider: string): Promise<void> => {
    const next = await listAccounts(provider)
    if (next === undefined) {
      setRowsError(true)
      return
    }
    setRowsError(false)
    setRows(next)
  }, [listAccounts])

  useEffect(() => { void loadProviders() }, [loadProviders])

  const provider = providers?.[0]

  useEffect(() => {
    if (provider === undefined) return
    void loadRows(provider)
  }, [provider, loadRows])

  const poll = useCallback(async (): Promise<void> => {
    if (provider === undefined) return
    const fresh = await accountLog(provider, sinceRef.current)
    if (fresh === undefined || fresh.length === 0) return
    const last = fresh[fresh.length - 1]
    if (last !== undefined) sinceRef.current = last.seq
    setEntries(previous => [...previous, ...fresh])
  }, [provider, accountLog])

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
    const result = await addAccount(provider, account)
    setPending(false)
    // Clear the secret from component state before rendering the outcome.
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
    const result = op === 'relogin'
      ? await reloginAccount(provider, account.id)
      : await reprofileAccount(provider, account.id)
    setBusy(undefined)
    setOutcome(result.ok
      ? t(op === 'relogin' ? 'accounts.relogin.ok' : 'accounts.reprofile.ok')
      : result.message ?? t('accounts.list.loadError'))
    await Promise.all([loadRows(provider), poll()])
  }, [provider, reloginAccount, reprofileAccount, loadRows, poll, t])

  return (
    <div className={css.section}>
      <p className={css.intro}>{t('accounts.intro')}</p>
      {loadError && <div className={css.error} role="alert">{t('accounts.loadError')}</div>}
      {error !== undefined && <div className={css.error} role="alert">{error}</div>}
      {done !== undefined && <div className={css.notice} role="status">{done}</div>}

      {providers !== undefined && providers.length === 0 && (
        <p className={css.hint}>{t('accounts.noProviders')}</p>
      )}

      {provider !== undefined && (
        <div className={css.group}>
          <div className={css.field}>
            <span className={css.label}>{t('accounts.provider.label')}</span>
            <select
              className={css.select}
              value={provider}
              disabled={pending}
              onChange={() => { /* one route today; the control shows which */ }}
            >
              {providers?.map(route => <option key={route} value={route}>{route}</option>)}
            </select>
            <span className={css.hint}>{t('accounts.provider.hint')}</span>
          </div>

          <div className={css.field}>
            <span className={css.label}>
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
      )}

      {provider !== undefined && (
        <div className={css.listSection}>
          <div className={css.listHead}>
            <h3 className={css.listTitle}>{t('accounts.list.title')}</h3>
            <span className={css.listSpacer} />
            <Button onClick={() => { void loadRows(provider) }}>{t('accounts.list.refresh')}</Button>
          </div>
          <p className={css.hint}>{t('accounts.list.hint')}</p>
          {rowsError && <div className={css.error} role="alert">{t('accounts.list.loadError')}</div>}
          {outcome !== undefined && <div className={css.notice} role="status">{outcome}</div>}
          {rows !== undefined && rows.length === 0 && <p className={css.hint}>{t('accounts.list.empty')}</p>}

          <div className={css.rows}>
            {rows?.map((row) => {
              const open = expanded.includes(row.id)
              const running = busy?.id === row.id ? busy.op : undefined
              return (
                <div key={row.id} className={css.row}>
                  <div className={css.rowHead}>
                    <button
                      type="button"
                      className={css.rowToggle}
                      aria-expanded={open}
                      onClick={() => { toggle(row.id) }}
                    >
                      <span className={css.rowLabel}>{row.label}</span>
                      <span className={row.configured ? css.badge : `${css.badge ?? ''} ${css.badgeOrphan ?? ''}`.trim()}>
                        {row.configured ? t('accounts.list.configured') : t('accounts.list.orphan')}
                      </span>
                      <span className={css.badge}>
                        {open ? t('accounts.list.collapse') : t('accounts.list.expand')}
                      </span>
                    </button>
                    <div className={css.rowActions}>
                      <Button
                        disabled={running !== undefined}
                        onClick={() => { void repair(row, 'relogin') }}
                      >
                        {running === 'relogin' ? t('accounts.relogin.busy') : t('accounts.relogin')}
                      </Button>
                      <Button
                        title={t('accounts.reprofile.warn')}
                        disabled={running !== undefined}
                        onClick={() => { void repair(row, 'reprofile') }}
                      >
                        {running === 'reprofile' ? t('accounts.reprofile.busy') : t('accounts.reprofile')}
                      </Button>
                    </div>
                  </div>
                  {open && (
                    <div className={css.fields}>
                      {row.fields.map(field => (
                        <div key={field.label} className={css.fieldRow}>
                          <span className={css.fieldLabel}>{field.label}</span>
                          <span className={css.fieldValue}>{field.value}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {provider !== undefined && (
        <div className={css.logSection}>
          <div className={css.logHead}>
            <h3 className={css.logTitle}>{t('accounts.log.title')}</h3>
            <span className={css.listSpacer} />
            <Button onClick={() => { setEntries([]) }}>{t('accounts.log.clear')}</Button>
          </div>
          <p className={css.hint}>{t('accounts.log.hint')}</p>
          {entries.length === 0
            ? <p className={css.hint}>{t('accounts.log.empty')}</p>
            : (
              <div className={css.log} role="log">
                {entries.map(entry => (
                  <div key={entry.seq} className={levelClass(entry.level)}>
                    <span className={css.logTime}>{clock(entry.at)}</span>
                    <span className={css.logAccount}>{entry.account}</span>
                    <span className={css.logEvent}>{entry.event}</span>
                    <span className={css.logDetail}>{entry.detail}</span>
                  </div>
                ))}
              </div>
            )}
        </div>
      )}
    </div>
  )
}
