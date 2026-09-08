/**
 * Trigger candidate menu: renders the InputTriggerService menu store into the
 * conversation.input.overlay anchor. Closed state renders null (the overlay
 * slot stays mounted); groups render in roster order under localized title
 * rows. A pending group keeps showing the items it already had (the reducer
 * retains them across a query refinement) and falls back to two skeleton
 * rows only while it has none; pointer picks route back through
 * the service (combobox pattern — focus never leaves the textarea, so rows
 * are mousedown-handled and the highlight is exposed via
 * aria-activedescendant on the listbox). A source publishing crumbs gets a
 * breadcrumb header pinned above the scrolling list.
 */
import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14, IconChevronRightOutline14, ReferenceIcon, useAnchoredMaxHeight } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './MenuView.module.css'
import type { InputTriggerCandidate } from '../types.ts'
import type { MenuState } from '../core/contract.ts'
import type { MenuViewInjected } from './slots.ts'
import type { MenuKey } from './locales.ts'

/** Full menu props: injected face + the locale seat. */
export type MenuViewProps = MenuViewInjected & PropsLocale<'slash.menu'>

/** Design cap on the list height (figma SLASH 39:26572 MenuDropdown). */
const MAX_HEIGHT = 320

/** DOM id of one option row (the aria-activedescendant target). */
function optionId(source: string, index: number): string {
  return `dsh-slash-option-${source}-${index}`
}

/** One collapsible headed run of candidates inside a source group. */
interface MenuSegmentRow {
  readonly index: number
  readonly item: InputTriggerCandidate
}

/** A headed, collapsible run of candidates (a group or an in-group section). */
interface MenuSegment {
  readonly key: string
  readonly source: string
  readonly headingLabel: string
  readonly rows: readonly MenuSegmentRow[]
}

/**
 * Split one ready group into collapsible headed runs: a single group-level
 * run for sources without item.section headings, or one run per contiguous
 * item.section value. A source that hides its group title AND carries no
 * section headings produces no heading and no run.
 */
function segmentsOf(
  group: MenuState['groups'][number],
  resolveGroupTitle: (source: string) => string,
): readonly MenuSegment[] {
  const { items } = group
  if (items.length === 0) return []
  const sectioned = items.some(item => item.section !== undefined)
  if (!sectioned) {
    if (group.showGroupTitle === false) return []
    return [{
      key: `group:${group.source}`,
      source: group.source,
      headingLabel: resolveGroupTitle(group.source),
      rows: items.map((item, index) => ({ index, item })),
    }]
  }
  type SegmentBuilder = { key: string; source: string; headingLabel: string; rows: MenuSegmentRow[] }
  const out: SegmentBuilder[] = []
  let current: SegmentBuilder | null = null
  items.forEach((item, index) => {
    const section = item.section ?? ''
    if (current === null || current.headingLabel !== section) {
      current = {
        key: `${group.source}#${section}`,
        source: group.source,
        headingLabel: section,
        rows: [],
      }
      out.push(current)
    }
    current.rows.push({ index, item })
  })
  return out
}

/**
 * Render the candidate menu overlay entry.
 * @param props - injected face (the menu store and the pick route); `t` rides the standard locale seat.
 * @returns the dropdown while open; null while closed.
 */
export function MenuView({ menu, headers, onPick, onCrumb, onHover, onDismiss, t }: MenuViewProps) {
  const state = useSyncExternalStore(
    fn => menu.subscribe(fn),
    () => menu.getSnapshot(),
  )
  const crumbs = useSyncExternalStore(
    fn => headers.subscribe(fn),
    () => headers.getSnapshot(),
  )
  const listRef = useRef<HTMLDivElement>(null)
  // The list is bottom-anchored above the composer; clamp the design cap to
  // the space above it, re-measured on every store update (the anchor moves
  // when the composer grows).
  const maxHeight = useAnchoredMaxHeight(listRef, MAX_HEIGHT, state)
  const highlight = state.open ? state.highlight : null

  // DSH-FORK(browser): collapsible trigger-menu sections. The section holding
  // the active highlight is expanded by default; all others start minimized.
  // Manual toggles win until the menu closes and reopens. Keyboard highlight
  // movement into a collapsed section re-expands it.
  // EXIT: upstream adopts collapsible trigger-menu sections.
  const [collapsedSections, setCollapsedSections] = useState<ReadonlySet<string>>(new Set())
  const manualCollapseRef = useRef(false)

  const allSegments = useMemo(() => state.groups.flatMap(group =>
    segmentsOf(group, source => t(source as MenuKey))), [state.groups, t])

  // The segment containing the current highlight.
  const highlightedSegmentKey = useMemo(() => {
    if (highlight === null) return null
    return allSegments.find(segment => segment.source === highlight.source
      && segment.rows.some(row => row.index === highlight.index))?.key ?? null
  }, [highlight, allSegments])

  const defaultCollapsed = useMemo(() => {
    const keys = allSegments.map(segment => segment.key)
    if (highlightedSegmentKey !== null) {
      return new Set(keys.filter(key => key !== highlightedSegmentKey))
    }
    return new Set(keys.slice(1))
  }, [allSegments, highlightedSegmentKey])

  // Apply the default collapse while no manual preference exists; clear the
  // manual flag when the menu closes so the next open starts from defaults.
  useEffect(() => {
    if (!state.open) {
      manualCollapseRef.current = false
      return
    }
    if (!manualCollapseRef.current) setCollapsedSections(defaultCollapsed)
  }, [state.open, defaultCollapsed])

  // Keyboard highlight landing in a collapsed section re-expands it.
  useEffect(() => {
    if (highlightedSegmentKey === null) return
    setCollapsedSections((prev) => {
      if (!prev.has(highlightedSegmentKey)) return prev
      const next = new Set(prev)
      next.delete(highlightedSegmentKey)
      return next
    })
  }, [highlightedSegmentKey])

  const toggleSection = (key: string): void => {
    manualCollapseRef.current = true
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  // Focus stays in the textarea (combobox pattern), so the browser never
  // scrolls the active option into view on keyboard moves — do it here.
  useEffect(() => {
    if (highlight === null) return
    document.getElementById(optionId(highlight.source, highlight.index))
      ?.scrollIntoView({ block: 'nearest' })
  }, [highlight])
  // Dismiss on pointer outside the menu AND outside the composer card
  // (clicking the textarea or bottom bar must not close the menu).
  useEffect(() => {
    if (!state.open) return
    const onPointerDown = (ev: PointerEvent): void => {
      if (!(ev.target instanceof Node)) return
      if (listRef.current?.contains(ev.target)) return
      const composerCard = listRef.current?.closest('[data-composer-card]')
      if (composerCard?.contains(ev.target)) return
      onDismiss()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => { document.removeEventListener('pointerdown', onPointerDown, true) }
  }, [state.open, onDismiss])
  if (!state.open) return null
  return (
    // The listbox role sits on the scrolling viewport, not this shell: a
    // breadcrumb header is not an option, and a listbox may not carry one.
    <div ref={listRef} className={css.menu} style={{ maxHeight }} data-trigger-menu="">
      {state.groups.map((group) => {
        const trail = crumbs.get(group.source)
        return trail === undefined ? null : (
          <nav key={group.source} className={css.crumbs} aria-label={t('crumbs.aria')}>
            {trail.map((crumb, index) => (
              <Fragment key={`${String(index)}-${crumb.value}`}>
                {index > 0 && <span className={css.crumbSeparator} aria-hidden><IconChevronRightOutline14 /></span>}
                <button
                  type="button"
                  className={clsx(css.crumb, crumb.current === true && css.crumbCurrent)}
                  aria-current={crumb.current === true ? 'location' : undefined}
                  disabled={crumb.current === true}
                  // mousedown, not click: the composer keeps focus, same as a row.
                  onMouseDown={(ev) => {
                    ev.preventDefault()
                    onCrumb(group.source, index)
                  }}
                >
                  {crumb.label}
                </button>
              </Fragment>
            ))}
          </nav>
        )
      })}
      <div
        className={css.viewport}
        role="listbox"
        aria-label={t('suggestions.aria')}
        aria-activedescendant={highlight !== null ? optionId(highlight.source, highlight.index) : undefined}
      >
        {state.groups.map((group) => {
          // Pending groups with no retained items keep the skeleton surface.
          if (group.status === 'pending' && group.items.length === 0) {
            return (
              <div key={group.source} role="status" aria-label={t('loading')} data-source={group.source}>
                <div className={css.skeletonRow}><span className={css.skeletonBar} style={{ width: '32%' }} /></div>
                <div className={css.skeletonRow}><span className={css.skeletonBar} style={{ width: '48%' }} /></div>
              </div>
            )
          }
          // Ready groups with no candidates render nothing (auto-close handles it).
          if (group.status === 'ready' && group.items.length === 0) return null
          const segments = segmentsOf(group, source => t(source as MenuKey))
          return (
            <Fragment key={group.source}>
              {segments.map((segment) => {
                const collapsed = collapsedSections.has(segment.key)
                return (
                  <Fragment key={segment.key}>
                    <button
                      type="button"
                      className={clsx(css.groupTitle, css.groupToggle)}
                      aria-expanded={!collapsed}
                      data-trigger-heading=""
                      onClick={() => { toggleSection(segment.key) }}
                    >
                      <IconChevronDownOutline14 className={clsx(css.groupChevron, collapsed && css.groupChevronCollapsed)} />
                      <span className={css.groupName}>{segment.headingLabel}</span>
                    </button>
                    <div hidden={collapsed}>
                      {segment.rows.map(({ index, item }) => {
                        const active = highlight !== null && highlight.source === group.source && highlight.index === index
                        return (
                          <button
                            id={optionId(group.source, index)}
                            key={optionId(group.source, index)}
                            type="button"
                            role="option"
                            aria-selected={active}
                            className={clsx(css.item, active && css.active)}
                            onMouseDown={(ev) => {
                              ev.preventDefault()
                              onPick(group.source, index)
                            }}
                            onMouseMove={active ? undefined : () => { onHover(group.source, index) }}
                          >
                            {item.icon !== undefined && (
                              <span className={css.itemIcon} aria-hidden>
                                <ReferenceIcon kind={item.icon} size={16} />
                              </span>
                            )}
                            <span className={css.itemName}>{item.name}</span>
                            {item.description !== undefined && <span className={css.itemDescription}>{item.description}</span>}
                            {item.drill === true && (
                              <span className={css.trailing}>
                                <span className={css.drillHintText} aria-hidden>{t('drill.hint')}</span>
                                <kbd className={css.drillHint} aria-hidden>{t('drill.key')}</kbd>
                                <span
                                  role="button"
                                  aria-label={t('drill.aria')}
                                  className={css.drill}
                                  onMouseDown={(ev) => {
                                    ev.preventDefault()
                                    ev.stopPropagation()
                                    onPick(group.source, index, 'drill')
                                  }}
                                >
                                  <IconChevronRightOutline14 />
                                </span>
                              </span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  </Fragment>
                )
              })}
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}
