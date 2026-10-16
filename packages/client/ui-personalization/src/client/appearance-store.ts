/**
 * The live appearance policy: one snapshot of every field, shared between the
 * Settings section and the engine that paints it.
 *
 * The row is the durable owner, but a control cannot wait for it. A write goes
 * out over the settings transport and the page is repainted from the snapshot in
 * the same step, so moving a control changes the window immediately; the row's
 * own value is adopted whenever it arrives, which keeps two windows and a
 * restart consistent. Reading the form alone made a write land in the profile
 * while the field and the page stayed exactly as they were.
 *
 * @module @deepseek-ai/dsh-client-ui-personalization/appearance-store
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  APPEARANCE_DEFAULTS, APPEARANCE_FIELDS, type AppearanceField, type AppearanceValues,
} from '../options.ts'
import { opacityPercent } from './appearance.ts'

export type { AppearanceField } from '../options.ts'

/** The live values the engine paints and the section edits. */
export interface AppearanceSource {
  /** Every field as one plain object. */
  values: () => AppearanceValues
  /**
   * Subscribe to any field.
   * @param fn - invalidation callback.
   * @returns the unsubscribe function.
   */
  subscribe: (fn: () => void) => () => void
}

/** Whether the row the section edits is served: the settings form's status. */
export type AppearanceRowStatus = 'loading' | 'ready' | 'unavailable'

/** The write state the section reports beside its controls. */
export interface AppearanceSaveState {
  /** Fields this window shows that the row refused, most often because the running Host predates them. */
  readonly refused: readonly AppearanceField[]
}

/** The opacity fields, which accept the fraction the first build stored. */
const OPACITY_FIELDS = ['shellOpacity', 'surfaceOpacity', 'panelOpacity'] as const

/** Live appearance values, written by the section and read by the engine. */
export class AppearancePolicy implements AppearanceSource {
  /** Every field, replaced as one immutable record on each change. */
  readonly appearance: SnapshotStore<AppearanceValues> = createSnapshotStore<AppearanceValues>({ ...APPEARANCE_DEFAULTS })
  /** Fields the row refused, for the section's notice. */
  readonly saveState: SnapshotStore<AppearanceSaveState> = createSnapshotStore<AppearanceSaveState>({ refused: [] })
  /** Whether the Host serves the row: the form's status, `unavailable` without a form. */
  readonly rowStatus: SnapshotStore<AppearanceRowStatus>

  readonly #host: ConfigForm<Partial<AppearanceValues>> | undefined
  readonly #adopted: (() => void) | undefined
  /** Fields this window has set that the row has not taken yet. */
  readonly #pending = new Set<AppearanceField>()
  /** Write generation per field, so only the latest write of a field settles it. */
  readonly #generation = new Map<AppearanceField, number>()

  /**
   * @param host - the row's live form, or undefined when this deployment composes no row.
   */
  constructor(host?: ConfigForm<Partial<AppearanceValues>>) {
    this.#host = host
    this.rowStatus = createSnapshotStore<AppearanceRowStatus>(host === undefined ? 'unavailable' : host.getSnapshot().status)
    if (host !== undefined) {
      this.#adopted = host.subscribe(() => { this.adopt(host) })
      this.adopt(host)
    }
  }

  /** Stop following the row. */
  dispose(): void {
    this.#adopted?.()
  }

  /** Every field as one plain object. */
  values(): AppearanceValues {
    return this.appearance.getSnapshot()
  }

  /**
   * Subscribe to any field.
   * @param fn - invalidation callback.
   * @returns the unsubscribe function.
   */
  subscribe(fn: () => void): () => void {
    return this.appearance.subscribe(fn)
  }

  /**
   * Publish one field: the page changes on the gesture, and the row keeps the value.
   *
   * Choosing a backdrop while every layer is solid would show nothing, so that one
   * choice also lowers the shell and the surface to 80%.
   * @param field - the field to write.
   * @param value - the value to publish.
   */
  set<K extends AppearanceField>(field: K, value: AppearanceValues[K]): void {
    const current = this.appearance.getSnapshot()
    const next = field === 'fontScale' || field === 'lineHeight' ? Math.round(value as number) as AppearanceValues[K] : value
    if (field === 'backdrop' && next !== 'none'
      && opacityPercent(current.shellOpacity) >= 100 && opacityPercent(current.surfaceOpacity) >= 100) {
      this.#write('shellOpacity', 80)
      this.#write('surfaceOpacity', 80)
    }
    this.#write(field, next)
  }

  /** Restore every field to the deployment default. */
  reset(): void {
    for (const field of APPEARANCE_FIELDS) this.#write(field, APPEARANCE_DEFAULTS[field])
  }

  #write<K extends AppearanceField>(field: K, value: AppearanceValues[K]): void {
    const current = this.appearance.getSnapshot()
    if (current[field] === value) return
    // Local first. A row can refuse a write - a field its loaded schema does not have, a
    // transport that is momentarily unavailable - and a control that waits for the refusal
    // to resolve is a control that appears to do nothing.
    this.appearance.set({ ...current, [field]: value })
    this.#pending.add(field)
    const generation = (this.#generation.get(field) ?? 0) + 1
    this.#generation.set(field, generation)
    const written = this.#host?.set(field, value)
    if (written === undefined) return
    written.then((accepted) => {
      if (this.#generation.get(field) !== generation) return
      if (accepted) {
        // The row has the value now, so its own copy may speak for this field again.
        this.#pending.delete(field)
        this.#markRefused(field, false)
      } else {
        // The field stays pending: this window shows a choice the row does not have, and
        // adopting the row's value back would undo the gesture in front of the operator.
        this.#markRefused(field, true)
      }
    }, () => {
      if (this.#generation.get(field) === generation) this.#markRefused(field, true)
    })
  }

  #markRefused(field: AppearanceField, refused: boolean): void {
    const current = this.saveState.getSnapshot().refused
    if (current.includes(field) === refused) return
    this.saveState.set({ refused: refused ? [...current, field] : current.filter(item => item !== field) })
  }

  /**
   * Take the row's values, so this window follows a change made in another one.
   * @param host - the row's live form.
   */
  private adopt(host: ConfigForm<Partial<AppearanceValues>>): void {
    const snapshot = host.getSnapshot()
    if (snapshot.status !== this.rowStatus.getSnapshot()) this.rowStatus.set(snapshot.status)
    const section = snapshot.value
    if (section === undefined) return
    // The user layer is what was chosen; the resolved value can carry the composition
    // default underneath it.
    const user = (snapshot.user ?? {}) as Partial<AppearanceValues>
    const merged: AppearanceValues = { ...APPEARANCE_DEFAULTS, ...section, ...user }
    for (const field of OPACITY_FIELDS) merged[field] = opacityPercent(merged[field])
    const local = this.appearance.getSnapshot()
    const next: AppearanceValues = { ...local }
    // A field this window has set and the row has not accepted keeps the local value: the
    // alternative is a control that snaps back to whatever the row still holds.
    for (const field of APPEARANCE_FIELDS) copyField(next, this.#pending.has(field) ? local : merged, field)
    if (APPEARANCE_FIELDS.some(field => next[field] !== local[field])) this.appearance.set(next)
  }
}

/**
 * Copy one field between two records of the same type.
 * @param target - the record written.
 * @param source - the record read.
 * @param field - the field copied.
 */
function copyField<K extends AppearanceField>(target: Pick<AppearanceValues, K>, source: Pick<AppearanceValues, K>, field: K): void {
  target[field] = source[field]
}
