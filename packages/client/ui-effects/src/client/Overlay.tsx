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
import type { EffectsKey } from './locales.ts'
import styles from './overlay.module.css'

/** CSS-module lookup with a stable fallback (noUncheckedIndexedAccess). */
const css = (key: string): string => (styles)[key] ?? key

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
  key: EffectsKey
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
 *
 * The catalog is locale-free: a scene's name is the copy key `effects.scene.<id>`
 * in this plugin's dictionaries, so the labels travel with the rest of the copy.
 */
const SCENES: Scene[] = [
  { id: 'aurora', key: 'effects.scene.aurora', url: `${SCENE_SOURCE}photo-1531366936337-7c912a4589a7${SCENE_QUERY}` },
  { id: 'alpine-lake', key: 'effects.scene.alpine-lake', url: `${SCENE_SOURCE}photo-1508672019048-805c876b67e2${SCENE_QUERY}` },
  { id: 'misty-pines', key: 'effects.scene.misty-pines', url: `${SCENE_SOURCE}photo-1448375240586-882707db888b${SCENE_QUERY}` },
  { id: 'turquoise-coast', key: 'effects.scene.turquoise-coast', url: `${SCENE_SOURCE}photo-1505142468610-359e7d316be0${SCENE_QUERY}` },
  { id: 'dunes', key: 'effects.scene.dunes', url: `${SCENE_SOURCE}photo-1509316785289-025f5b846b35${SCENE_QUERY}` },
  { id: 'dolomites', key: 'effects.scene.dolomites', url: `${SCENE_SOURCE}photo-1520769945061-0a448c463865${SCENE_QUERY}` },
  { id: 'autumn-woods', key: 'effects.scene.autumn-woods', url: `${SCENE_SOURCE}photo-1507783548227-544c3b8fc065${SCENE_QUERY}` },
  { id: 'cliff-coast', key: 'effects.scene.cliff-coast', url: `${SCENE_SOURCE}photo-1507525428034-b723cf961d3e${SCENE_QUERY}` },
  { id: 'canyon', key: 'effects.scene.canyon', url: `${SCENE_SOURCE}photo-1469854523086-cc02fe5d8800${SCENE_QUERY}` },
  { id: 'starry-night', key: 'effects.scene.starry-night', url: `${SCENE_SOURCE}photo-1470071459604-3b5ec3a7fe05${SCENE_QUERY}` },
  { id: 'snow-peaks', key: 'effects.scene.snow-peaks', url: `${SCENE_SOURCE}photo-1483728642387-6c3bdd6c93e5${SCENE_QUERY}` },
  { id: 'bamboo', key: 'effects.scene.bamboo', url: `${SCENE_SOURCE}photo-1503785640985-f62e3aeee448${SCENE_QUERY}` },
  { id: 'still-lake', key: 'effects.scene.still-lake', url: `${SCENE_SOURCE}photo-1439066615861-d1af74d74000${SCENE_QUERY}` },
  { id: 'desert-rock', key: 'effects.scene.desert-rock', url: `${SCENE_SOURCE}photo-1473580044384-7ba9967e16a0${SCENE_QUERY}` },
  { id: 'green-hills', key: 'effects.scene.green-hills', url: `${SCENE_SOURCE}photo-1472214103451-9374bd1c798e${SCENE_QUERY}` },
  { id: 'alpine-dawn', key: 'effects.scene.alpine-dawn', url: `${SCENE_SOURCE}photo-1469474968028-56623f02e42e${SCENE_QUERY}` },
  { id: 'redwood', key: 'effects.scene.redwood', url: `${SCENE_SOURCE}photo-1511497584788-876760111969${SCENE_QUERY}` },
  { id: 'waterfall', key: 'effects.scene.waterfall', url: `${SCENE_SOURCE}photo-1432405972618-c60b0225b8f9${SCENE_QUERY}` },
  { id: 'tropical-island', key: 'effects.scene.tropical-island', url: `${SCENE_SOURCE}photo-1505228395891-9a51e7e86bf6${SCENE_QUERY}` },
  { id: 'iceland-falls', key: 'effects.scene.iceland-falls', url: `${SCENE_SOURCE}photo-1483347756197-71ef80e95f73${SCENE_QUERY}` },
  { id: 'sunset-valley', key: 'effects.scene.sunset-valley', url: `${SCENE_SOURCE}photo-1500530855697-b586d89ba3ee${SCENE_QUERY}` },
  { id: 'reef', key: 'effects.scene.reef', url: `${SCENE_SOURCE}photo-1544551763-46a013bb70d5${SCENE_QUERY}` },
  { id: 'pine-forest', key: 'effects.scene.pine-forest', url: `${SCENE_SOURCE}photo-1441974231531-c6227db76b6e${SCENE_QUERY}` },
  { id: 'mountain-night', key: 'effects.scene.mountain-night', url: `${SCENE_SOURCE}photo-1519681393784-d120267933ba${SCENE_QUERY}` },
]

/** The catalog as the mount reads it: each scene's id with the copy key for its name. */
export const SCENE_CATALOG: readonly { id: string; key: EffectsKey }[] = SCENES

/** Every string this overlay shows, resolved by the plugin from its dictionaries. */
export interface EffectsOverlayCopy {
  /** Accessible name of the focus button. */
  focusEnter: string
  /** Visible label of the focus button. */
  focusButton: string
  /** Accessible name of the lock surface. */
  focusDialog: string
  /** Title of the passcode gate. */
  focusLocked: string
  /** Hint above the passcode input. */
  focusHint: string
  /** Accessible name of the passcode input. */
  focusPasscode: string
  /** Label of the unlock button. */
  focusUnlock: string
  /** Scene name by scene id, for the caption and the image's accessible name. */
  scenes: Readonly<Record<string, string>>
}

/** The unlock passcode. Cosmetic focus aid, never a security boundary. */
const UNLOCK_CODE = '1234'

export interface EffectsOverlayProps {
  whaleEnabled: SnapshotStore<boolean>
  focusEnabled: SnapshotStore<boolean>
  whaleOpacity: SnapshotStore<number>
  whaleSize: SnapshotStore<number>
  whaleStatic: SnapshotStore<boolean>
  copy: EffectsOverlayCopy
}

/**
 * Render the whole effects overlay.
 * @param props - reactive settings stores shared with the Settings row, and the localized copy.
 */
export function EffectsOverlay({
  whaleEnabled, focusEnabled, whaleOpacity, whaleSize, whaleStatic, copy,
}: EffectsOverlayProps) {
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

  const sceneName = (target: Scene): string => copy.scenes[target.id] ?? target.id

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
            aria-label={copy.focusEnter}
          >
            <span className={css('focusButtonIcon')}><FishLogo size={18} /></span>
            <span className={css('focusButtonLabel')}>{copy.focusButton}</span>
          </button>
        )
        : null}

      {showFocus && locked
        ? (
          <div className={css('lock')} role="dialog" aria-modal="true" aria-label={copy.focusDialog}>
            <div
              className={css('scene')}
              style={{ backgroundImage: `linear-gradient(rgba(5, 13, 26, 0.10) 0%, rgba(5, 13, 26, 0.38) 100%), url("${scene.url}")` }}
              role="img"
              aria-label={sceneName(scene)}
            />
            <div className={css('sceneLabel')}>{sceneName(scene)}</div>
            <div className={css('vignette')} />
            <div className={`${css('gate')} ${shake ? css('gateShake') : ''}`}>
              <FishLogo size={34} />
              <div className={css('gateTitle')}>{copy.focusLocked}</div>
              <div className={css('gateHint')}>{copy.focusHint}</div>
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
                aria-label={copy.focusPasscode}
              />
              <button type="button" className={css('unlockButton')} onClick={submit}>{copy.focusUnlock}</button>
            </div>
          </div>
        )
        : null}
    </div>
  )
}
