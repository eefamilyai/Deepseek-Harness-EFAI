/** The provider visibility list as a pure function of the catalog and the hidden set. */
import type { HiddenProvider } from '../index.ts'

/** One provider row of the settings list. */
export interface ProviderRow {
  id: string
  name: string
  /** Whether the provider is left out of the model picker. */
  hidden: boolean
}

/** What the list shows. */
export type VisibilityView =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; rows: readonly ProviderRow[]; writable: boolean }

/** A catalog provider: a picker group, or a provider whose models failed to load. */
export interface CatalogProvider {
  id: string
  name: string
}

/**
 * Merge the providers the picker lists with the hidden ones, which the catalog no longer carries.
 * @param catalog - providers in the picker's catalog, groups and failures.
 * @param hidden - the hidden providers with their recorded names.
 * @returns one row per provider, catalog order first, then hidden ones in the order they were hidden.
 */
export function providerRows(catalog: readonly CatalogProvider[], hidden: readonly HiddenProvider[]): ProviderRow[] {
  const hiddenIds = new Set(hidden.map(entry => entry.id))
  const rows: ProviderRow[] = []
  const seen = new Set<string>()
  for (const provider of catalog) {
    if (seen.has(provider.id)) continue
    seen.add(provider.id)
    rows.push({ id: provider.id, name: provider.name, hidden: hiddenIds.has(provider.id) })
  }
  for (const entry of hidden) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    rows.push({ id: entry.id, name: entry.name === '' ? entry.id : entry.name, hidden: true })
  }
  return rows
}

/**
 * The hidden list after one switch.
 * @param hidden - the current hidden list.
 * @param row - the provider switched.
 * @param visible - its new state.
 * @returns the next hidden list.
 */
export function toggled(hidden: readonly HiddenProvider[], row: CatalogProvider, visible: boolean): HiddenProvider[] {
  const rest = hidden.filter(entry => entry.id !== row.id)
  return visible ? rest : [...rest, { id: row.id, name: row.name }]
}

/**
 * The footer's rows: every provider no card on the page shows.
 * @param rows - the merged provider rows.
 * @param carded - ids of the providers a card currently shows.
 * @returns the rows without a card.
 */
export function uncarded(rows: readonly ProviderRow[], carded: ReadonlySet<string>): ProviderRow[] {
  return rows.filter(row => !carded.has(row.id))
}
