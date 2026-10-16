/**
 * The visibility switch inside one provider card of the Models settings page:
 * on when the provider shows in the model picker.
 *
 * While mounted, the switch reports its provider as carded so the footer list
 * leaves it out; the footer only lists providers no card shows.
 */
import { useEffect } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { HiddenProvider } from '../index.ts'
import type { CatalogProvider } from './model.ts'
import css from './VisibilityList.module.css'

/** What the card switch reads: the hidden list and whether it can be written. */
export interface CardVisibility {
  /** The hidden providers, or null until the row's settings load. */
  hidden: readonly HiddenProvider[] | null
  /** Whether the row accepts writes. */
  writable: boolean
}

/** Injected face: the hidden list, the switch action, and the carded registration. */
export interface ProviderCardSwitchInjected {
  hooks: {
    /** The row's hidden list and writability. */
    cardVisibility: HostObservable<CardVisibility>
  }
  /** Show or hide one provider. */
  setVisible: (row: CatalogProvider, visible: boolean) => void
  /** Record that a card shows this provider; the returned function withdraws it. */
  carded: (id: string) => () => void
}

/** Full component props. */
export type ProviderCardSwitchProps =
  PropsRuntime<'settings.models.provider-card'> & PropsLocale<'modelVisibility'> & InjectFace<ProviderCardSwitchInjected>

/**
 * Render the switch row of one provider card.
 * @param props - composed slot props.
 * @returns the switch row, or nothing until the hidden list loads.
 */
export function ProviderCardSwitch({ t, provider, useCardVisibility, setVisible, carded }: ProviderCardSwitchProps) {
  const id = provider.provider
  const name = provider.displayName
  const view = useCardVisibility(value => value)
  useEffect(() => carded(id), [carded, id])
  if (view.hidden === null) return null
  const hidden = view.hidden.some(entry => entry.id === id)
  return (
    <div className={css.cardRow} data-provider={id} data-hidden={hidden ? 'true' : 'false'}>
      <span className={css.cardLabel}>{hidden ? t('cardHidden') : t('cardShown')}</span>
      <Switch
        checked={!hidden}
        disabled={!view.writable}
        label={t('toggle', { name })}
        onChange={(next) => { setVisible({ id, name }, next) }}
      />
    </div>
  )
}
