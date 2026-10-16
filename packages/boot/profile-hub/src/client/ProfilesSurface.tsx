/**
 * The profiles surfaces: a page in the main column, reached from a sidebar
 * entry beside Plugins, and a landing page that opens on the profile that is
 * the launcher.
 *
 * Both render the same body — the profiles on this machine, what each one
 * holds, and the two ways to enter one — because they answer the same question;
 * only the frame around them differs.
 *
 * Entering a profile has two targets. A Desktop window is a second application
 * process that owns the profile outright, and is the only one of the two that
 * carries native window chrome; a browser target starts the profile as a Web
 * Host and navigates to it. The Desktop target is offered wherever the page
 * itself runs under the Desktop application, and disabled with the reason
 * everywhere else.
 *
 * A Host that predates a Remote method rejects with a TypeError rather than
 * answering a result, so every call is caught and shown; a blank list would
 * otherwise be indistinguishable from having no profiles.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button, Checkbox, IconEllipsisOutlineRegular, IconPlusOutlineRegular, IconUsersOutlineRegular, Input, Menu, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  CreateProfileRequest, OpenProfileTarget, ProfileHubState, ProfileSummary,
} from '@deepseek-ai/dsh-profile-hub/types'
import css from './ProfilesSurface.module.css'

/** One host call that answers with the machine's state, or the reason it could not. */
export type ProfilesLoad =
  | { readonly ok: true; readonly state: ProfileHubState }
  | { readonly ok: false; readonly message: string }

/** The outcome of entering a profile: a browser target navigates, so only refusal is rendered. */
export type ProfilesOpenResult =
  | { readonly ok: true; readonly opened: OpenProfileTarget }
  | { readonly ok: false; readonly message: string }

/** The Host calls these surfaces make, as plain data and callbacks. */
export interface ProfilesSurfaceInjected {
  /** Read every profile, and whether this host should open the landing page by itself. */
  readonly load: () => Promise<ProfilesLoad>
  /** Create one profile. */
  readonly create: (request: CreateProfileRequest) => Promise<ProfilesLoad>
  /** Remove one profile and everything it owns. */
  readonly remove: (name: string) => Promise<ProfilesLoad>
  /** Stop a profile host this one started. */
  readonly stop: (name: string) => Promise<ProfilesLoad>
  /** Choose the profile whose startup opens the landing page. */
  readonly makeLauncher: (name: string) => Promise<ProfilesLoad>
  /** Open the profile as a second Desktop window. */
  readonly openInApp: (name: string) => Promise<ProfilesOpenResult>
  /** Start the profile as a Web Host and navigate to it. */
  readonly openInBrowser: (name: string) => Promise<ProfilesOpenResult>
}

/** Full props of the `shell.overlay` landing entry. */
export type ProfilesLandingProps =
  PropsRuntime<'shell.overlay'> & PropsLocale<'profileHub'> & ProfilesSurfaceInjected

/** Full props of the `main` panel entry. */
export type ProfilesPanelProps =
  PropsRuntime<'main'> & PropsLocale<'profileHub'> & ProfilesSurfaceInjected

/** The one action currently running, so only its row and button show as busy. */
interface Busy {
  readonly kind: 'create' | 'app' | 'browser' | 'stop' | 'launcher' | 'remove'
  readonly name: string
}

/** The draft a new profile is created from. */
interface Draft {
  readonly name: string
  readonly title: string
  readonly workdir: string
  readonly clone: boolean
}

/** An empty draft: naming the profile is the one required field. */
const EMPTY_DRAFT: Draft = { name: '', title: '', workdir: '', clone: true }

/** The translated copy both surfaces render, taken from whichever entry's locale seat called. */
type Copy = ProfilesPanelProps['t']

/**
 * The initials a profile badge shows: at most two words of its title.
 * @param title - the profile's display title.
 * @returns one or two uppercase characters.
 */
function initials(title: string): string {
  const words = title.split(/[\s._-]+/).filter(word => word !== '')
  // Words are non-empty after the filter; Array.from keeps a surrogate pair as one initial.
  return words.slice(0, 2).map(word => Array.from(word)[0]).join('').toUpperCase()
}

/** What the shared body renders. */
interface BodyProps {
  readonly t: Copy
  readonly state: ProfileHubState | null
  readonly error: string | null
  readonly status: string | null
  readonly busy: Busy | null
  readonly draft: Draft
  readonly composing: boolean
  readonly confirming: string | null
  readonly onCompose: (composing: boolean) => void
  readonly onDraft: (draft: Draft) => void
  readonly onSubmit: () => void
  readonly onConfirm: (name: string) => void
  readonly onCancelConfirm: () => void
  readonly onOpenApp: (name: string) => void
  readonly onOpenBrowser: (name: string) => void
  readonly onStop: (name: string) => void
  readonly onMakeLauncher: (name: string) => void
  readonly onDelete: (name: string) => void
}

/**
 * The shared profile body: the two sections, the create form, and every refusal.
 * @param props - the loaded state, this session's draft and control, and the actions.
 * @returns the body.
 */
function ProfilesBody({
  t, state, error, status, busy, draft, composing, confirming, onCompose, onDraft, onSubmit, onConfirm,
  onCancelConfirm, onOpenApp, onOpenBrowser, onStop, onMakeLauncher, onDelete,
}: BodyProps) {
  const running = busy !== null
  const creating = busy?.kind === 'create'
  const yours = state === null ? [] : state.profiles.filter(profile => !profile.locked)
  const reserved = state === null ? [] : state.profiles.filter(profile => profile.locked)
  const row = (profile: ProfileSummary): ReactNode => (
    <ProfileRow
      key={profile.name}
      profile={profile}
      t={t}
      canOpenDesktop={state !== null && state.canOpenDesktop}
      busy={busy !== null && busy.name === profile.name ? busy.kind : null}
      held={running}
      confirming={confirming === profile.name}
      onConfirm={() => { onConfirm(profile.name) }}
      onCancelConfirm={onCancelConfirm}
      onOpenApp={() => { onOpenApp(profile.name) }}
      onOpenBrowser={() => { onOpenBrowser(profile.name) }}
      onStop={() => { onStop(profile.name) }}
      onMakeLauncher={() => { onMakeLauncher(profile.name) }}
      onDelete={() => { onDelete(profile.name) }}
    />
  )
  return (
    <div className={css.root}>
      <p className={css.lead}>{t('profileHub.description')}</p>
      {error !== null && <div className={css.error} role="alert">{error}</div>}
      {status !== null && <div className={css.status} role="status">{status}</div>}
      {state === null
        ? error === null && <p className={css.lead}>{t('profileHub.loadError')}</p>
        : (
          <>
            {state.profiles.length === 0 && <p className={css.empty}>{t('profileHub.empty')}</p>}
            {yours.length > 0 && (
              <section className={css.section}>
                <h3 className={css.sectionTitle}>{t('profileHub.section.yours')}</h3>
                <div className={css.list}>{yours.map(row)}</div>
              </section>
            )}
            {reserved.length > 0 && (
              <section className={css.section}>
                <h3 className={css.sectionTitle}>{t('profileHub.section.reserved')}</h3>
                <div className={css.list}>{reserved.map(row)}</div>
              </section>
            )}
            {composing
              ? (
                <div className={css.form}>
                  <div className={css.field}>
                    <span className={css.fieldLabel}>{t('profileHub.new.name')}</span>
                    <Input
                      value={draft.name}
                      placeholder={t('profileHub.new.namePlaceholder')}
                      aria-label={t('profileHub.new.name')}
                      disabled={creating}
                      onChange={(event) => { onDraft({ ...draft, name: event.target.value }) }}
                    />
                  </div>
                  <div className={css.field}>
                    <span className={css.fieldLabel}>{t('profileHub.new.label')}</span>
                    <Input
                      value={draft.title}
                      placeholder={t('profileHub.new.labelPlaceholder')}
                      aria-label={t('profileHub.new.label')}
                      disabled={creating}
                      onChange={(event) => { onDraft({ ...draft, title: event.target.value }) }}
                    />
                  </div>
                  <div className={css.field}>
                    <span className={css.fieldLabel}>{t('profileHub.new.workdir')}</span>
                    <Input
                      value={draft.workdir}
                      placeholder={t('profileHub.new.workdirPlaceholder')}
                      aria-label={t('profileHub.new.workdir')}
                      disabled={creating}
                      onChange={(event) => { onDraft({ ...draft, workdir: event.target.value }) }}
                    />
                  </div>
                  <Checkbox
                    checked={draft.clone}
                    disabled={creating}
                    label={t('profileHub.new.clone')}
                    onChange={(checked: boolean) => { onDraft({ ...draft, clone: checked }) }}
                  />
                  <div className={css.formActions}>
                    <Button variant="ghost" disabled={creating} onClick={() => { onCompose(false) }}>
                      {t('profileHub.keep')}
                    </Button>
                    <Button
                      variant="primary"
                      disabled={creating || draft.name.trim() === ''}
                      onClick={onSubmit}
                    >
                      {creating ? t('profileHub.new.creating') : t('profileHub.new.create')}
                    </Button>
                  </div>
                </div>
              )
              : (
                <div className={css.compose}>
                  <Button variant="outline" onClick={() => { onCompose(true) }}>
                    <span className={css.composeLabel}>
                      <IconPlusOutlineRegular size={14} />
                      {t('profileHub.new.toggle')}
                    </span>
                  </Button>
                </div>
              )}
          </>
        )}
    </div>
  )
}

/**
 * The `shell.overlay` landing entry: one frame-wide modal, shown on the profile
 * whose startup is the choice of profile.
 * @param props - the locale seat and the Host calls.
 * @returns the modal, or nothing while it is dismissed.
 */
export function ProfilesLanding({
  t, load, create, remove, stop, makeLauncher, openInApp, openInBrowser,
}: ProfilesLandingProps) {
  const surface = useProfiles({ t, load, create, remove, stop, makeLauncher, openInApp, openInBrowser })
  return (
    <Modal
      open={surface.open}
      onClose={surface.dismiss}
      closeLabel={t('profileHub.close')}
      title={t('profileHub.title')}
      {...modalClasses(css.landing)}
    >
      <ProfilesBody {...surface.bodyProps} />
    </Modal>
  )
}

/**
 * The `main` panel entry: the same list, as a page in the main column.
 * @param props - the locale seat and the Host calls.
 * @returns the page.
 */
export function ProfilesPanel({
  t, load, create, remove, stop, makeLauncher, openInApp, openInBrowser,
}: ProfilesPanelProps) {
  const surface = useProfiles({ t, load, create, remove, stop, makeLauncher, openInApp, openInBrowser })
  return (
    <div className={css.page}>
      <h2 className={css.pageTitle}>{t('profileHub.title')}</h2>
      <ProfilesBody {...surface.bodyProps} />
    </div>
  )
}

/**
 * The sidebar's profiles glyph; the sidebar owns the button, label, and
 * selected state around it.
 * @param props - the sidebar's icon share: the size it asks for.
 * @returns the icon element.
 */
export function ProfilesPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <IconUsersOutlineRegular size={size} />
}

/**
 * The optional card class a Modal takes. The primitive types it as a required
 * string, so an absent class is left out rather than passed as undefined.
 * @param className - the card class, when the sheet defines one.
 * @returns the props to spread into the Modal.
 */
function modalClasses(className: string | undefined): { className?: string } {
  return className === undefined ? {} : { className }
}

/** What one loaded surface exposes to its frame. */
interface Surface {
  readonly open: boolean
  readonly dismiss: () => void
  readonly bodyProps: BodyProps
}

/**
 * Load the machine's state once and hold this session's draft, status, and busy row.
 * @param props - the locale seat and the Host calls.
 * @returns the loaded state, this session's control, and the body props.
 */
function useProfiles({
  t, load, create, remove, stop, makeLauncher, openInApp, openInBrowser,
}: PropsLocale<'profileHub'> & ProfilesSurfaceInjected): Surface {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<ProfileHubState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState<Busy | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [composing, setComposing] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)

  /** Fold one call's outcome into the surface: the state it answers, or the reason it refused. */
  const fold = useCallback((result: ProfilesLoad): void => {
    if (result.ok) {
      setState(result.state)
      setError(null)
    } else {
      setError(result.message)
    }
  }, [])

  useEffect(() => {
    let live = true
    void load().then((result) => {
      if (!live) return
      fold(result)
      // The launcher profile exists to make this choice, so it lands here.
      if (result.ok && result.state.landing) setOpen(true)
    }).catch((reason: unknown) => {
      if (live) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { live = false }
  }, [load, fold])

  /** Run one row action, marking that row busy until it settles. */
  const run = useCallback((mark: Busy, operation: () => Promise<void>): void => {
    setBusy(mark)
    setStatus(null)
    operation().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { setBusy(null) })
  }, [])

  const bodyProps: BodyProps = {
    t,
    state,
    error,
    status,
    busy,
    draft,
    composing,
    confirming,
    onCompose: (next) => { setComposing(next); setStatus(null) },
    onDraft: setDraft,
    onSubmit: () => {
      const name = draft.name.trim()
      if (name === '') return
      run({ kind: 'create', name }, async () => {
        fold(await create({
          name,
          ...draft.title.trim() === '' ? {} : { title: draft.title.trim() },
          ...draft.workdir.trim() === '' ? {} : { workdir: draft.workdir.trim() },
          clone: draft.clone,
        }))
        setDraft(EMPTY_DRAFT)
        setComposing(false)
      })
    },
    onConfirm: setConfirming,
    onCancelConfirm: () => { setConfirming(null) },
    onOpenApp: (name) => {
      run({ kind: 'app', name }, async () => {
        const result = await openInApp(name)
        if (result.ok) setStatus(t('profileHub.open.app.done', { name }))
        else setError(result.message)
      })
    },
    onOpenBrowser: (name) => {
      run({ kind: 'browser', name }, async () => {
        const result = await openInBrowser(name)
        // A successful browser launch navigates this page away.
        if (!result.ok) setError(result.message)
      })
    },
    onStop: (name) => { run({ kind: 'stop', name }, async () => { fold(await stop(name)) }) },
    onMakeLauncher: (name) => { run({ kind: 'launcher', name }, async () => { fold(await makeLauncher(name)) }) },
    onDelete: (name) => {
      run({ kind: 'remove', name }, async () => {
        fold(await remove(name))
        setConfirming(null)
      })
    },
  }

  return { open, dismiss: () => { setOpen(false) }, bodyProps }
}

/**
 * One profile row: what it is, the two ways to enter it, and its management.
 * @param props - the profile, the locale seat, the open targets, and this row's actions.
 * @returns the row.
 */
function ProfileRow({
  profile, t, canOpenDesktop, busy, held, confirming, onOpenApp, onOpenBrowser, onStop, onMakeLauncher,
  onDelete, onConfirm, onCancelConfirm,
}: {
  readonly profile: ProfileSummary
  readonly t: Copy
  readonly canOpenDesktop: boolean
  readonly busy: Busy['kind'] | null
  readonly held: boolean
  readonly confirming: boolean
  readonly onOpenApp: () => void
  readonly onOpenBrowser: () => void
  readonly onStop: () => void
  readonly onMakeLauncher: () => void
  readonly onDelete: () => void
  readonly onConfirm: () => void
  readonly onCancelConfirm: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const removable = !profile.locked && !profile.current
  // The window this page is in already runs one profile; asking for a second
  // window on it would start a second owner of the same profile directory.
  const appTitle = profile.current
    ? t('profileHub.open.app.current')
    : canOpenDesktop ? undefined : t('profileHub.open.app.unavailable')
  const management: MenuEntry[] = [
    ...profile.launcher ? [] : [{ id: 'launcher', label: t('profileHub.launchOnStartup') } satisfies MenuEntry],
    ...profile.running ? [{ id: 'stop', label: t('profileHub.stop') } satisfies MenuEntry] : [],
    ...removable
      ? [{ type: 'separator', id: 'manage-separator' } satisfies MenuEntry,
        { id: 'delete', label: t('profileHub.delete'), danger: true } satisfies MenuEntry]
      : [],
  ]
  return (
    <div className={css.row} data-current={profile.current || undefined} data-running={profile.running || undefined}>
      <span className={css.badge} aria-hidden="true">{initials(profile.title)}</span>
      <div className={css.identity}>
        <div className={css.heading}>
          <span className={css.name}>{profile.title}</span>
          <span className={css.slug}>{profile.name}</span>
          {profile.current && <span className={css.chip}>{t('profileHub.badge.current')}</span>}
          {profile.launcher && <span className={`${css.chip} ${css.chipAccent}`}>{t('profileHub.badge.launcher')}</span>}
          {profile.running && <span className={`${css.chip} ${css.chipLive}`}>{t('profileHub.badge.running')}</span>}
          {profile.locked && <span className={css.chip}>{t('profileHub.badge.reserved')}</span>}
        </div>
        <div className={css.meta}>
          <span>
            {profile.chats === undefined
              ? t('profileHub.meta.shared')
              : t('profileHub.meta.chats', { count: profile.chats })}
          </span>
          <span className={css.dot} aria-hidden="true">·</span>
          <span>{t('profileHub.meta.bundles', { count: profile.bundles.length })}</span>
          {profile.workdir !== undefined && (
            <>
              <span className={css.dot} aria-hidden="true">·</span>
              <span className={css.path} title={profile.workdir}>{profile.workdir}</span>
            </>
          )}
        </div>
      </div>
      <div className={css.actions}>
        {confirming
          ? (
            <>
              <Button variant="ghost" disabled={held} onClick={onCancelConfirm}>{t('profileHub.keep')}</Button>
              <Button variant="primary" disabled={held} onClick={onDelete}>{t('profileHub.delete')}</Button>
            </>
          )
          : (
            <>
              <Button
                variant="primary"
                disabled={held || appTitle !== undefined}
                {...appTitle === undefined ? {} : { title: appTitle }}
                onClick={onOpenApp}
              >
                {busy === 'app' ? t('profileHub.open.app.busy') : t('profileHub.open.app')}
              </Button>
              <Button variant="outline" disabled={held} onClick={onOpenBrowser}>
                {busy === 'browser' ? t('profileHub.open.browser.busy') : t('profileHub.open.browser')}
              </Button>
              {management.length > 0 && (
                <Menu
                  open={menuOpen}
                  onClose={() => { setMenuOpen(false) }}
                  align="end"
                  items={management}
                  onSelect={(id) => {
                    setMenuOpen(false)
                    if (id === 'launcher') onMakeLauncher()
                    else if (id === 'stop') onStop()
                    else onConfirm()
                  }}
                  anchor={(
                    <Button
                      variant="ghost"
                      aria-label={t('profileHub.more')}
                      disabled={held}
                      onClick={() => { setMenuOpen(true) }}
                    >
                      <IconEllipsisOutlineRegular size={16} />
                    </Button>
                  )}
                />
              )}
            </>
          )}
      </div>
    </div>
  )
}
