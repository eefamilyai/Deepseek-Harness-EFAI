/**
 * The provider visibility list in the Models settings page: one switch per
 * provider, on when the provider shows in the model picker.
 */
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProviderRow, VisibilityView } from './model.ts'
import css from './VisibilityList.module.css'

/** Injected face: the live list, the last write's outcome, and the switch action. */
export interface VisibilityListInjected {
  hooks: {
    /** The list's current reading. */
    visibility: HostObservable<VisibilityView>
    /** Whether the last write was refused. */
    saveFailed: HostObservable<boolean>
  }
  /** Show or hide one provider. */
  setVisible: (row: ProviderRow, visible: boolean) => void
}

/** Full component props. */
export type VisibilityListProps =
  PropsRuntime<'settings.models.footer'> & PropsLocale<'modelVisibility'> & InjectFace<VisibilityListInjected>

/**
 * Render the list.
 * @param props - composed slot props.
 * @returns the section.
 */
export function VisibilityList({ t, useVisibility, useSaveFailed, setVisible }: VisibilityListProps) {
  const view = useVisibility(value => value)
  const saveFailed = useSaveFailed(value => value)
  return (
    <section className={css.section} aria-labelledby="model-visibility-title">
      <h3 id="model-visibility-title" className={css.title}>{t('title')}</h3>
      <p className={css.hint}>{t('hint')}</p>
      {view.kind === 'loading' ? <p className={css.note}>{t('loading')}</p> : null}
      {view.kind === 'unavailable' ? <p className={css.note}>{t('unavailable')}</p> : null}
      {view.kind === 'error' ? <p className={css.error}>{t('error', { message: view.message })}</p> : null}
      {view.kind === 'ready' && view.rows.length === 0 ? <p className={css.note}>{t('empty')}</p> : null}
      {view.kind === 'ready' && view.rows.length > 0
        ? (
          <ul className={css.list}>
            {view.rows.map(row => (
              <li key={row.id} className={css.row} data-provider={row.id} data-hidden={row.hidden ? 'true' : 'false'}>
                <span className={css.name}>
                  {row.name}
                  {row.hidden ? <span className={css.tag}>{t('hiddenTag')}</span> : null}
                </span>
                <Switch
                  checked={!row.hidden}
                  disabled={!view.writable}
                  label={t('toggle', { name: row.name })}
                  onChange={(next) => { setVisible(row, next) }}
                />
              </li>
            ))}
          </ul>
        )
        : null}
      {saveFailed ? <p className={css.error} role="alert">{t('saveFailed')}</p> : null}
    </section>
  )
}
