/**
 * The live appearance policy: one snapshot store per field, sharing the row's
 * values between the Settings section and the engine that paints them.
 *
 * The row is the durable owner, but a control cannot wait for it. A write goes
 * out over the settings transport and the page is repainted from the store in
 * the same step, so moving a control changes the window immediately; the row's
 * own value is adopted whenever it arrives, which keeps two windows and a
 * restart consistent. Reading the form alone made a write land in the profile
 * while the field and the page stayed exactly as they were.
 *
 * @module @deepseek-ai/dsh-client-ui-personalization/appearance-store
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { APPEARANCE_DEFAULTS, opacityPercent, type AppearanceValues } from './appearance.ts'

/** One field of the row, as the policy stores it. */
export type AppearanceField = keyof AppearanceValues

/** Every field, in the order the reset writes them. */
export const APPEARANCE_FIELDS: readonly AppearanceField[] = [
  'fontFamily', 'fontScale', 'accent', 'radiusScale', 'shellOpacity', 'surfaceOpacity', 'panelOpacity',
]

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

/** Live appearance values, written by the section and read by the engine. */
export class AppearancePolicy implements AppearanceSource {
  /** The interface font stack, or empty for the theme's own. */
  readonly fontFamily: SnapshotStore<string> = createSnapshotStore(APPEARANCE_DEFAULTS.fontFamily)
  /** Root font size as a percentage. */
  readonly fontScale: SnapshotStore<number> = createSnapshotStore(APPEARANCE_DEFAULTS.fontScale)
  /** The accent colour, or empty for the theme's own. */
  readonly accent: SnapshotStore<string> = createSnapshotStore(APPEARANCE_DEFAULTS.accent)
  /** The corner-radius multiplier. */
  readonly radiusScale: SnapshotStore<number> = createSnapshotStore(APPEARANCE_DEFAULTS.radiusScale)
  /** Window opacity as a percentage. */
  readonly shellOpacity: SnapshotStore<number> = createSnapshotStore(APPEARANCE_DEFAULTS.shellOpacity)
  /** Content-surface opacity as a percentage. */
  readonly surfaceOpacity: SnapshotStore<number> = createSnapshotStore(APPEARANCE_DEFAULTS.surfaceOpacity)
  /** Settings panel and menu opacity as a percentage. */
  readonly panelOpacity: SnapshotStore<number> = createSnapshotStore(APPEARANCE_DEFAULTS.panelOpacity)

  readonly #host: ConfigForm<Partial<AppearanceValues>> | undefined

  /**
   * @param host - the row's live form, or undefined when this deployment composes no row.
   */
  constructor(host?: ConfigForm<Partial<AppearanceValues>>) {
    this.#host = host
    if (host !== undefined) {
      const off = host.subscribe(() => { this.adopt(host) })
      this.#adopted = off
      this.adopt(host)
    }
  }

  readonly #adopted: (() => void) | undefined

  /** Stop following the row. */
  dispose(): void {
    this.#adopted?.()
  }

  /** Every field as one plain object. */
  values(): AppearanceValues {
    return {
      fontFamily: this.fontFamily.getSnapshot(),
      fontScale: this.fontScale.getSnapshot(),
      accent: this.accent.getSnapshot(),
      radiusScale: this.radiusScale.getSnapshot(),
      shellOpacity: this.shellOpacity.getSnapshot(),
      surfaceOpacity: this.surfaceOpacity.getSnapshot(),
      panelOpacity: this.panelOpacity.getSnapshot(),
    }
  }

  /**
   * Subscribe to any field.
   * @param fn - invalidation callback.
   * @returns the unsubscribe function.
   */
  subscribe(fn: () => void): () => void {
    const offs = [
      this.fontFamily.subscribe(fn), this.fontScale.subscribe(fn), this.accent.subscribe(fn),
      this.radiusScale.subscribe(fn), this.shellOpacity.subscribe(fn), this.surfaceOpacity.subscribe(fn),
      this.panelOpacity.subscribe(fn),
    ]
    return () => { for (const off of offs) off() }
  }

  /**
   * Set the interface font.
   * @param value - a CSS font stack, or empty for the theme's own.
   */
  setFontFamily(value: string): void {
    this.#write('fontFamily', value, this.fontFamily)
  }

  /**
   * Set the root font size.
   * @param value - a percentage.
   */
  setFontScale(value: number): void {
    this.#write('fontScale', Math.round(value), this.fontScale)
  }

  /**
   * Set the accent colour.
   * @param value - a CSS colour, or empty for the theme's own.
   */
  setAccent(value: string): void {
    this.#write('accent', value, this.accent)
  }

  /**
   * Set the corner-radius multiplier.
   * @param value - the multiplier.
   */
  setRadiusScale(value: number): void {
    this.#write('radiusScale', value, this.radiusScale)
  }

  /**
   * Set the window opacity.
   * @param value - a percentage.
   */
  setShellOpacity(value: number): void {
    this.#write('shellOpacity', value, this.shellOpacity)
  }

  /**
   * Set the content-surface opacity.
   * @param value - a percentage.
   */
  setSurfaceOpacity(value: number): void {
    this.#write('surfaceOpacity', value, this.surfaceOpacity)
  }

  /**
   * Set the settings-panel opacity.
   * @param value - a percentage.
   */
  setPanelOpacity(value: number): void {
    this.#write('panelOpacity', value, this.panelOpacity)
  }

  /**
   * Restore every field to the deployment default.
   */
  reset(): void {
    this.setFontFamily(APPEARANCE_DEFAULTS.fontFamily)
    this.setFontScale(APPEARANCE_DEFAULTS.fontScale)
    this.setAccent(APPEARANCE_DEFAULTS.accent)
    this.setRadiusScale(APPEARANCE_DEFAULTS.radiusScale)
    this.setShellOpacity(APPEARANCE_DEFAULTS.shellOpacity)
    this.setSurfaceOpacity(APPEARANCE_DEFAULTS.surfaceOpacity)
    this.setPanelOpacity(APPEARANCE_DEFAULTS.panelOpacity)
  }

  /**
   * Publish one field: the page changes on the gesture, and the row keeps the value.
   * @param field - the field to write.
   * @param value - the value to publish.
   * @param store - the store that field is displayed from.
   */
  #write<K extends AppearanceField>(field: K, value: AppearanceValues[K], store: SnapshotStore<AppearanceValues[K]>): void {
    if (store.getSnapshot() === value) return
    // Local first. A row can refuse a write - a field its loaded schema does not have, a
    // transport that is momentarily unavailable - and a control that waits for the refusal
    // to resolve is a control that appears to do nothing.
    store.set(value)
    this.#pending.add(field)
    void this.#host?.set(field, value)?.then(() => {
      // The row has the value now, so its own copy may speak for this field again.
      this.#pending.delete(field)
    }, () => {
      // The row refused or dropped the update. The field stays pending, because this
      // window is showing a choice the row does not have yet and adopting its value back
      // would undo the gesture in front of the operator.
    })
  }

  /**
   * Fields this window has set that the row has not taken yet.
   */
  readonly #pending = new Set<AppearanceField>()

  /**
   * Read one field from this policy's own stores.
   * @param field - the field to read.
   * @returns the value this window is showing.
   */
  #local(field: AppearanceField): AppearanceValues[AppearanceField] {
    switch (field) {
      case 'fontFamily': return this.fontFamily.getSnapshot()
      case 'fontScale': return this.fontScale.getSnapshot()
      case 'accent': return this.accent.getSnapshot()
      case 'radiusScale': return this.radiusScale.getSnapshot()
      case 'shellOpacity': return this.shellOpacity.getSnapshot()
      case 'surfaceOpacity': return this.surfaceOpacity.getSnapshot()
      case 'panelOpacity': return this.panelOpacity.getSnapshot()
    }
  }

  /**
   * Take the row's values, so this window follows a change made in another one.
   * @param host - the row's live form.
   */
  private adopt(host: ConfigForm<Partial<AppearanceValues>>): void {
    const snapshot = host.getSnapshot()
    const section = snapshot.value
    if (section === undefined) return
    // The user layer is what was chosen; the resolved value can carry the composition
    // default underneath it.
    const user = (snapshot.user ?? {}) as Partial<AppearanceValues>
    const merged: AppearanceValues = { ...APPEARANCE_DEFAULTS, ...section, ...user }
    // A field this window has set and the row has not accepted keeps the local value: the
    // alternative is a control that snaps back to whatever the row still holds.
    for (const field of this.#pending) merged[field] = this.#local(field) as never
    if (merged.fontFamily !== this.fontFamily.getSnapshot()) this.fontFamily.set(merged.fontFamily)
    if (merged.fontScale !== this.fontScale.getSnapshot()) this.fontScale.set(merged.fontScale)
    if (merged.accent !== this.accent.getSnapshot()) this.accent.set(merged.accent)
    if (merged.radiusScale !== this.radiusScale.getSnapshot()) this.radiusScale.set(merged.radiusScale)
    const shell = opacityPercent(merged.shellOpacity)
    if (shell !== this.shellOpacity.getSnapshot()) this.shellOpacity.set(shell)
    const surface = opacityPercent(merged.surfaceOpacity)
    if (surface !== this.surfaceOpacity.getSnapshot()) this.surfaceOpacity.set(surface)
    const panel = opacityPercent(merged.panelOpacity)
    if (panel !== this.panelOpacity.getSnapshot()) this.panelOpacity.set(panel)
  }
}
