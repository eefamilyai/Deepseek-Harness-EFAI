/**
 * Frame-wide visual effects overlay, rendered through a private React root.
 *
 *  - Whale: the official DeepSeek FishLogo drifting softly behind the chrome
 *    (or pinned static and centered when the user opts in).
 *  - Focus button: a bottom-right pill that locks the workspace into a calm,
 *    rotating nature scene.
 *  - Focus lock: the full-screen photographic nature scene with a 4-digit
 *    passcode gate (1234 unlocks). Each lock advances to the next scene.
 */
import { useSyncExternalStore, useState } from 'react'
import { FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import styles from './overlay.module.css'

/** CSS-module lookup with a stable fallback (noUncheckedIndexedAccess). */
const css = (key: string): string => (styles as Record<string, string>)[key] ?? key

/** Reactive store reader. */
function useStore<T>(store: SnapshotStore<T>): T {
  return useSyncExternalStore(
    (onChange: () => void) => store.subscribe(onChange),
    () => store.getSnapshot(),
    () => store.getSnapshot(),
  )
}

/** One photographic nature scene, rotated on every lock. */
interface Scene {
  id: string
  label: string
  url: string
}

/**
 * Real photographic scenes (remote Unsplash source set, 2400w).
 * The lock layer adds a translucent tone gradient over each photo and the CSS
 * keeps a dark fallback color, so an offline lock still degrades gracefully.
 */
const SCENES: Scene[] = [
  { id: 'aurora', label: 'Aurora', url: 'https://images.unsplash.com/photo-1483347756197-71ef80e95f73?w=2400&q=80&auto=format&fit=crop' },
  { id: 'alpine', label: 'Alpine', url: 'https://images.unsplash.com/photo-1469474968028-56623f02e42e?w=2400&q=80&auto=format&fit=crop' },
  { id: 'dusk', label: 'Dusk', url: 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?w=2400&q=80&auto=format&fit=crop' },
  { id: 'reef', label: 'Reef', url: 'https://images.unsplash.com/photo-1544551763-46a013bb70d5?w=2400&q=80&auto=format&fit=crop' },
  { id: 'meadow', label: 'Meadow', url: 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=2400&q=80&auto=format&fit=crop' },
  { id: 'night', label: 'Night', url: 'https://images.unsplash.com/photo-1519681393784-d120267933ba?w=2400&q=80&auto=format&fit=crop' },
]

/** The unlock passcode. Cosmetic focus aid, never a security boundary. */
const UNLOCK_CODE = '1234'

export interface EffectsOverlayProps {
  whaleEnabled: SnapshotStore<boolean>
  focusEnabled: SnapshotStore<boolean>
  whaleOpacity: SnapshotStore<number>
  whaleSize: SnapshotStore<number>
  whaleStatic: SnapshotStore<boolean>
}

/**
 * Render the whole effects overlay.
 * @param props - reactive settings stores shared with the Settings row.
 */
export function EffectsOverlay({ whaleEnabled, focusEnabled, whaleOpacity, whaleSize, whaleStatic }: EffectsOverlayProps) {
  const showWhale = useStore(whaleEnabled)
  const showFocus = useStore(focusEnabled)
  const opacity = useStore(whaleOpacity)
  const size = useStore(whaleSize)
  const staticWhale = useStore(whaleStatic)
  const [locked, setLocked] = useState(false)
  const [scene, setScene] = useState<Scene>(SCENES[0] as Scene)
  const [sceneSeq, setSceneSeq] = useState(0)
  const [code, setCode] = useState('')
  const [shake, setShake] = useState(false)

  const lock = (): void => {
    setScene(SCENES[sceneSeq % SCENES.length] as Scene)
    setSceneSeq(seq => seq + 1)
    setCode('')
    setShake(false)
    setLocked(true)
  }

  const unlock = (): void => {
    setLocked(false)
    setCode('')
    setShake(false)
  }

  const submit = (): void => {
    if (code === UNLOCK_CODE) {
      unlock()
    } else {
      setShake(true)
      setCode('')
      window.setTimeout(() => { setShake(false) }, 450)
    }
  }

  return (
    <div className={css('root')} aria-hidden={locked ? undefined : true}>
      {showWhale && !locked
        ? (
          <div
            className={`${css('whale')} ${staticWhale ? css('whaleStatic') : ''}`}
            style={{ opacity, width: size }}
          >
            <FishLogo size={size} />
          </div>
        )
        : null}

      {showFocus && !locked
        ? (
          <button
            type="button"
            className={css('focusButton')}
            onClick={lock}
            aria-label="Enter focus mode"
          >
            <span className={css('focusButtonIcon')}><FishLogo size={18} /></span>
            <span className={css('focusButtonLabel')}>Focus</span>
          </button>
        )
        : null}

      {showFocus && locked
        ? (
          <div className={css('lock')} role="dialog" aria-modal="true" aria-label="Focus lock">
            <div
              className={css('scene')}
              style={{ backgroundImage: `linear-gradient(rgba(5, 13, 26, 0.18) 0%, rgba(5, 13, 26, 0.55) 100%), url("${scene.url}")` }}
              role="img"
              aria-label={scene.label}
            />
            <div className={css('sceneLabel')}>{scene.label}</div>
            <div className={css('vignette')} />
            <div className={`${css('gate')} ${shake ? css('gateShake') : ''}`}>
              <FishLogo size={34} />
              <div className={css('gateTitle')}>Focus locked</div>
              <div className={css('gateHint')}>Enter passcode to unlock</div>
              <input
                className={css('codeInput')}
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={4}
                value={code}
                autoFocus
                onChange={(event) => { setCode(event.target.value.replace(/\D/g, '')) }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && code.length === 4) submit()
                }}
                aria-label="Focus lock passcode"
              />
              <button type="button" className={css('unlockButton')} onClick={submit}>Unlock</button>
            </div>
          </div>
        )
        : null}
    </div>
  )
}
