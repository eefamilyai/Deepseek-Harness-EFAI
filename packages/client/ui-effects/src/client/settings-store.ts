/**
 * ui-effects settings policy: live whale/focus toggles plus whale size,
 * opacity, and static placement, mirrored from the Host user-settings
 * document with process-local fallback when settings are unavailable.
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  DEFAULT_FOCUS_ENABLED, DEFAULT_WHALE_ENABLED, DEFAULT_WHALE_OPACITY, DEFAULT_WHALE_SIZE, DEFAULT_WHALE_STATIC,
  FOCUS_ENABLED_FIELD, WHALE_ENABLED_FIELD, WHALE_OPACITY_FIELD, WHALE_SIZE_FIELD, WHALE_STATIC_FIELD,
  type EffectsSettings,
} from '../effects-settings.ts'

/** Clamp a number into an inclusive range. */
const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value))

/** Reactive preference stores shared by the overlay and its Settings row. */
export class EffectsSettingsPolicy {
  /** Whether the background whale shows. */
  readonly whaleEnabled: SnapshotStore<boolean> = createSnapshotStore(DEFAULT_WHALE_ENABLED)
  /** Whether the Focus control shows. */
  readonly focusEnabled: SnapshotStore<boolean> = createSnapshotStore(DEFAULT_FOCUS_ENABLED)
  /** Whale opacity, 0.05 to 1. */
  readonly whaleOpacity: SnapshotStore<number> = createSnapshotStore(DEFAULT_WHALE_OPACITY)
  /** Whale width in pixels, 120 to 900. */
  readonly whaleSize: SnapshotStore<number> = createSnapshotStore(DEFAULT_WHALE_SIZE)
  /** Whether the whale holds still instead of animating. */
  readonly whaleStatic: SnapshotStore<boolean> = createSnapshotStore(DEFAULT_WHALE_STATIC)
  private readonly host: ConfigForm<EffectsSettings> | undefined

  /** @param host - durable preference scope owned by the settings surface. */
  constructor(host?: ConfigForm<EffectsSettings>) {
    this.host = host
    if (host !== undefined) {
      host.subscribe(() => { this.adopt(host) })
      this.adopt(host)
    }
  }

  /**
   * Show or hide the whale, and save the choice.
   * @param value - true to show it.
   */
  setWhaleEnabled(value: boolean): void {
    if (this.whaleEnabled.getSnapshot() === value) return
    this.whaleEnabled.set(value)
    void this.host?.set(WHALE_ENABLED_FIELD, value)
  }

  /**
   * Show or hide the Focus control, and save the choice.
   * @param value - true to show it.
   */
  setFocusEnabled(value: boolean): void {
    if (this.focusEnabled.getSnapshot() === value) return
    this.focusEnabled.set(value)
    void this.host?.set(FOCUS_ENABLED_FIELD, value)
  }

  /**
   * Set the whale's opacity, clamped to 0.05–1, and save it.
   * @param value - the requested opacity.
   */
  setWhaleOpacity(value: number): void {
    const next = clamp(value, 0.05, 1)
    if (this.whaleOpacity.getSnapshot() === next) return
    this.whaleOpacity.set(next)
    void this.host?.set(WHALE_OPACITY_FIELD, next)
  }

  /**
   * Set the whale's width, rounded and clamped to 120–900 pixels, and save it.
   * @param value - the requested width.
   */
  setWhaleSize(value: number): void {
    const next = clamp(Math.round(value), 120, 900)
    if (this.whaleSize.getSnapshot() === next) return
    this.whaleSize.set(next)
    void this.host?.set(WHALE_SIZE_FIELD, next)
  }

  /**
   * Stop or start the whale's animation, and save the choice.
   * @param value - true to hold it still.
   */
  setWhaleStatic(value: boolean): void {
    if (this.whaleStatic.getSnapshot() === value) return
    this.whaleStatic.set(value)
    void this.host?.set(WHALE_STATIC_FIELD, value)
  }

  private adopt(host: ConfigForm<EffectsSettings>): void {
    const section = host.getSnapshot().value
    if (section === undefined) return
    if (this.whaleEnabled.getSnapshot() !== section.whaleEnabled) {
      this.whaleEnabled.set(section.whaleEnabled)
    }
    if (this.focusEnabled.getSnapshot() !== section.focusEnabled) {
      this.focusEnabled.set(section.focusEnabled)
    }
    if (this.whaleOpacity.getSnapshot() !== section.whaleOpacity) {
      this.whaleOpacity.set(clamp(section.whaleOpacity, 0.05, 1))
    }
    if (this.whaleSize.getSnapshot() !== section.whaleSize) {
      this.whaleSize.set(clamp(Math.round(section.whaleSize), 120, 900))
    }
    if (this.whaleStatic.getSnapshot() !== section.whaleStatic) {
      this.whaleStatic.set(section.whaleStatic)
    }
  }
}
