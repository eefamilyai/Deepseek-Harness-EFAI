/**
 * The Accounts settings section: add a DeepSeek web login from the UI.
 *
 * The form is deliberately three fields and a button. Nothing is written to
 * disk here: the Host sidecar tests the login and, on success, persists the
 * account and publishes the new per-login route, which is what makes it
 * selectable in the model picker. A failure comes back as a plain reason.
 *
 * The password lives in component state only for the duration of one submit and
 * is cleared as soon as the answer arrives; it is never stored, logged, or
 * echoed back by this page.
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import css from './AccountsSection.module.css'

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
}

/** Full component props: runtime share + locale seat + injected face. */
export type AccountsSectionComponentProps =
  PropsRuntime<'settings.section'> & PropsLocale<'accounts'> & AccountsSectionInjected

/** Which identifier the form is filling in. */
type IdentifierKind = 'email' | 'mobile'

/**
 * Render the Accounts section.
 * @param props - composed slot props.
 * @returns the section element tree.
 */
export function AccountsSection({ t, listProviders, addAccount }: AccountsSectionComponentProps) {
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

  const load = useCallback(async (): Promise<void> => {
    const routes = await listProviders()
    if (routes === undefined) {
      setLoadError(true)
      return
    }
    setLoadError(false)
    setProviders(routes)
  }, [listProviders])

  useEffect(() => { void load() }, [load])

  const provider = providers?.[0]
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
  }, [provider, kind, email, mobile, areaCode, password, addAccount, t])

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
    </div>
  )
}
