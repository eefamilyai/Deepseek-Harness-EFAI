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

/**
 * Unsplash source prefix and its query.
 *
 * Every scene URL is `SCENE_SOURCE + photo id + SCENE_QUERY`. Wider and less
 * compressed than a 2400w/80 set, so a full-screen lock reads sharp on a
 * high-density display instead of visibly upscaled.
 */
const SCENE_SOURCE = 'https://images.unsplash.com/'
const SCENE_QUERY = '?w=3000&q=85&auto=format&fit=crop'

/** One photographic nature scene, rotated on every lock. */
interface Scene {
  id: string
  label: string
  url: string
}

/**
 * Real photographic scenes (remote Unsplash source set, 3000w).
 *
 * The set spans every nature family the lock can show — alpine, forest,
 * desert, coast, water, sky — so consecutive locks never repeat a mood, and a
 * full cycle stays fresh. Each id was verified to resolve as a JPEG at this
 * width; the lock layer adds a translucent tone gradient over each photo and
 * the CSS keeps a dark fallback color, so an offline lock still degrades
 * gracefully.
 */
const SCENES: Scene[] = [
  { id: 'aurora', label: 'Aurora', url: `${SCENE_SOURCE}photo-1531366936337-7c912a4589a7${SCENE_QUERY}` },
  { id: 'alpine-lake', label: 'Alpine Lake', url: `${SCENE_SOURCE}photo-1508672019048-805c876b67e2${SCENE_QUERY}` },
  { id: 'misty-pines', label: 'Misty Pines', url: `${SCENE_SOURCE}photo-1448375240586-882707db888b${SCENE_QUERY}` },
  { id: 'turquoise-coast', label: 'Turquoise Coast', url: `${SCENE_SOURCE}photo-1505142468610-359e7d316be0${SCENE_QUERY}` },
  { id: 'dunes', label: 'Desert Dunes', url: `${SCENE_SOURCE}photo-1509316785289-025f5b846b35${SCENE_QUERY}` },
  { id: 'dolomites', label: 'Dolomites', url: `${SCENE_SOURCE}photo-1520769945061-0a448c463865${SCENE_QUERY}` },
  { id: 'autumn-woods', label: 'Autumn Woods', url: `${SCENE_SOURCE}photo-1507783548227-544c3b8fc065${SCENE_QUERY}` },
  { id: 'cliff-coast', label: 'Cliff Coast', url: `${SCENE_SOURCE}photo-1507525428034-b723cf961d3e${SCENE_QUERY}` },
  { id: 'canyon', label: 'Canyon', url: `${SCENE_SOURCE}photo-1469854523086-cc02fe5d8800${SCENE_QUERY}` },
  { id: 'starry-night', label: 'Starry Night', url: `${SCENE_SOURCE}photo-1470071459604-3b5ec3a7fe05${SCENE_QUERY}` },
  { id: 'snow-peaks', label: 'Snow Peaks', url: `${SCENE_SOURCE}photo-1483728642387-6c3bdd6c93e5${SCENE_QUERY}` },
  { id: 'bamboo', label: 'Bamboo Grove', url: `${SCENE_SOURCE}photo-1503785640985-f62e3aeee448${SCENE_QUERY}` },
  { id: 'still-lake', label: 'Still Lake', url: `${SCENE_SOURCE}photo-1439066615861-d1af74d74000${SCENE_QUERY}` },
  { id: 'desert-rock', label: 'Desert Rock', url: `${SCENE_SOURCE}photo-1473580044384-7ba9967e16a0${SCENE_QUERY}` },
  { id: 'green-hills', label: 'Green Hills', url: `${SCENE_SOURCE}photo-1472214103451-9374bd1c798e${SCENE_QUERY}` },
  { id: 'alpine-dawn', label: 'Alpine Dawn', url: `${SCENE_SOURCE}photo-1469474968028-56623f02e42e${SCENE_QUERY}` },
  { id: 'redwood', label: 'Redwood', url: `${SCENE_SOURCE}photo-1511497584788-876760111969${SCENE_QUERY}` },
  { id: 'waterfall', label: 'Waterfall', url: `${SCENE_SOURCE}photo-1432405972618-c60b0225b8f9${SCENE_QUERY}` },
  { id: 'tropical-island', label: 'Tropical Island', url: `${SCENE_SOURCE}photo-1505228395891-9a51e7e86bf6${SCENE_QUERY}` },
  { id: 'iceland-falls', label: 'Iceland Falls', url: `${SCENE_SOURCE}photo-1483347756197-71ef80e95f73${SCENE_QUERY}` },
  { id: 'sunset-valley', label: 'Sunset Valley', url: `${SCENE_SOURCE}photo-1500530855697-b586d89ba3ee${SCENE_QUERY}` },
  { id: 'reef', label: 'Reef', url: `${SCENE_SOURCE}photo-1544551763-46a013bb70d5${SCENE_QUERY}` },
  { id: 'pine-forest', label: 'Pine Forest', url: `${SCENE_SOURCE}photo-1441974231531-c6227db76b6e${SCENE_QUERY}` },
  { id: 'mountain-night', label: 'Mountain Night', url: `${SCENE_SOURCE}photo-1519681393784-d120267933ba${SCENE_QUERY}` },
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
              style={{ backgroundImage: `linear-gradient(rgba(5, 13, 26, 0.10) 0%, rgba(5, 13, 26, 0.38) 100%), url("${scene.url}")` }}
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
