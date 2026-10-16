/**
 * The Skills page in the main column: the skills the loader sees, grouped by
 * folder; an editor for the selected or new skill; and, when opened, the Skill
 * Builder chat beside them.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Button, IconPlusOutlineRegular, IconRefreshOutlineRegular, IconSearchOutlineRegular, IconSkillOutlineRegular,
  IconSparkleRegular, Input, Modal, Switch,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  SkillDocument, SkillEntry, SkillRemoved, SkillRootView, SkillSaved, SkillSaveRequest, SkillsCatalog,
} from '../types.ts'
import type { BuilderView } from './builder.ts'
import {
  blankDraft, changed, copyDraft, defaultRoot, draftOf, groupSkills, saveRequest, type Draft,
} from './model.ts'
import css from './SkillsPage.module.css'

/** How often the list re-reads the skill folders while the Skill Builder is open. */
export const REFRESH_MS = 4000

/** One call's answer, folded for the page. */
export type Answer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }

/** What the page calls. */
export interface SkillsPageInjected {
  hooks: {
    /** The embedded Skill Builder's state. */
    builder: HostObservable<BuilderView<SessionReference>>
  }
  load: () => Promise<Answer<SkillsCatalog>>
  read: (file: string) => Promise<Answer<SkillDocument>>
  save: (request: SkillSaveRequest) => Promise<Answer<SkillSaved>>
  remove: (file: string) => Promise<Answer<SkillRemoved>>
  openBuilder: () => void
  freshBuilder: () => void
  closeBuilder: () => void
  /** Start a Skill Builder session in the main column; answers the failure, if any. */
  launchBuilder: () => Promise<string | null>
}

/** Full page props. */
export type SkillsPageProps =
  PropsRuntime<'main'> & PropsLocale<'skillsStudio'> & InjectFace<SkillsPageInjected>
  & PropsRenderSlots<'skillsStudio.builder.conversation'>

/** A question the page is asking before it acts, about the named skill. */
type Confirm =
  | { readonly kind: 'discard'; readonly name: string; readonly then: () => void }
  | { readonly kind: 'remove'; readonly name: string; readonly file: string }

/** The catalog before the first answer. */
const NO_CATALOG: SkillsCatalog = { roots: [], skills: [] }

/** The line under the editor. */
type Status = { readonly tone: 'info' | 'error'; readonly text: string } | null

/**
 * Render the Skills page.
 * @param props - composed slot props.
 * @returns the page.
 */
export function SkillsPage(props: SkillsPageProps) {
  const { t, load, read, save, remove, useBuilder } = props
  const [catalog, setCatalog] = useState<SkillsCatalog>(NO_CATALOG)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [document, setDocument] = useState<SkillDocument | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [baseline, setBaseline] = useState<Draft | null>(null)
  const [status, setStatus] = useState<Status>(null)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const builder = useBuilder(value => value)

  const refresh = useCallback(async (): Promise<void> => {
    const answer = await load()
    if (!answer.ok) {
      setLoadError(answer.message)
      return
    }
    setLoadError(null)
    setCatalog(answer.value)
    setLoaded(true)
  }, [load])

  useEffect(() => { void refresh() }, [refresh])

  const builderOpen = builder.kind !== 'closed'
  // The builder writes skill files itself, so the list follows the folders while it is open.
  useEffect(() => {
    if (!builderOpen) return undefined
    const timer = setInterval(() => { void refresh() }, REFRESH_MS)
    return () => { clearInterval(timer) }
  }, [builderOpen, refresh])

  const dirty = draft !== null && (draft.file === undefined || changed(draft, baseline))
  /** Run an action now, or after the user agrees to drop unsaved changes. */
  const guarded = (action: () => void): void => {
    // A new draft with nothing typed yet is not worth a question.
    if (dirty && (draft.file !== undefined || draft.name !== '' || draft.description !== '')) setConfirm({ kind: 'discard', name: draft.name, then: action })
    else action()
  }

  const openSkill = async (file: string): Promise<void> => {
    const answer = await read(file)
    if (!answer.ok) {
      setStatus({ tone: 'error', text: t('failed', { message: answer.message }) })
      return
    }
    setDocument(answer.value)
    const next = draftOf(answer.value)
    setDraft(next)
    setBaseline(next)
    setStatus(answer.value.problem === undefined ? null : { tone: 'error', text: t('problem', { problem: answer.value.problem }) })
  }

  // The new-skill button is disabled until a writable folder is known.
  const newRoot = defaultRoot(catalog.roots)
  const startNew = (root: string): void => {
    setDocument(null)
    setDraft(blankDraft(root))
    setBaseline(null)
    setStatus(null)
  }

  const submit = async (draft: Draft): Promise<void> => {
    setBusy(true)
    setStatus({ tone: 'info', text: t('saving') })
    const answer = await save(saveRequest(draft))
    setBusy(false)
    if (!answer.ok) {
      setStatus({ tone: 'error', text: t('failed', { message: answer.message }) })
      return
    }
    await refresh()
    await openSkill(answer.value.file)
    setStatus({ tone: 'info', text: t('saved', { file: answer.value.file }) })
  }

  const confirmRemove = async (file: string): Promise<void> => {
    setConfirm(null)
    setBusy(true)
    const answer = await remove(file)
    setBusy(false)
    if (!answer.ok) {
      setStatus({ tone: 'error', text: t('failed', { message: answer.message }) })
      return
    }
    setDocument(null)
    setDraft(null)
    setBaseline(null)
    await refresh()
    setStatus({ tone: 'info', text: t('removed', { path: answer.value.trashedTo }) })
  }

  const launch = async (): Promise<void> => {
    const failure = await props.launchBuilder()
    if (failure !== null) setStatus({ tone: 'error', text: t('builder.failed', { message: failure }) })
  }

  const groups = useMemo(() => groupSkills(catalog.roots, catalog.skills, query), [catalog, query])

  return (
    <div className={css.page} data-builder={builderOpen ? 'open' : 'closed'}>
      <header className={css.header}>
        <div className={css.heading}>
          <h2 className={css.title}>{t('title')}</h2>
          <p className={css.lead}>{t('lead')}</p>
        </div>
        <div className={css.actions}>
          <Button variant="ghost" onClick={() => { void launch() }}>{t('builderSession')}</Button>
          <Button variant={builderOpen ? 'primary' : 'outline'} onClick={builderOpen ? props.closeBuilder : props.openBuilder} aria-pressed={builderOpen}>
            <IconSparkleRegular size={14} />
            {t('builder')}
          </Button>
          <Button
            variant="outline"
            disabled={newRoot === undefined}
            onClick={newRoot === undefined ? undefined : () => { guarded(() => { startNew(newRoot) }) }}
          >
            <IconPlusOutlineRegular size={14} />
            {t('new')}
          </Button>
        </div>
      </header>
      <div className={css.columns}>
        <nav className={css.list} aria-label={t('title')}>
          <div className={css.searchRow}>
            <Input
              className={String(css.search)}
              icon={<IconSearchOutlineRegular size={14} />}
              placeholder={t('search')}
              aria-label={t('search')}
              value={query}
              onChange={(event) => { setQuery(event.target.value) }}
            />
            <button type="button" className={css.iconButton} aria-label={t('refresh')} title={t('refresh')} onClick={() => { void refresh() }}>
              <IconRefreshOutlineRegular size={14} />
            </button>
          </div>
          <SkillList
            t={t}
            catalog={catalog}
            loaded={loaded}
            loadError={loadError}
            groups={groups}
            query={query}
            selected={draft?.file}
            onPick={(file) => { guarded(() => { void openSkill(file) }) }}
          />
        </nav>
        <section className={css.editor}>
          {draft === null
            ? <p className={css.placeholder}>{t('pick')}</p>
            : (
              <Editor
                t={t}
                draft={draft}
                document={document}
                roots={catalog.roots}
                dirty={dirty}
                busy={busy}
                status={status}
                onChange={setDraft}
                onSave={() => { void submit(draft) }}
                onRevert={() => { setDraft(baseline) }}
                onRemove={(file) => { setConfirm({ kind: 'remove', file, name: draft.name }) }}
                onCopy={(root, opened) => {
                  setDraft(copyDraft(opened, root))
                  setBaseline(null)
                  setDocument(null)
                  setStatus(null)
                }}
              />
            )}
          {draft === null && status !== null ? <p className={css.status} data-tone={status.tone}>{status.text}</p> : null}
        </section>
        {builderOpen
          ? (
            <aside className={css.builder} aria-label={t('builder.title')}>
              <BuilderColumn {...props} view={builder} />
            </aside>
          )
          : null}
      </div>
      {confirm === null
        ? null
        : (
          <ConfirmDialog
            t={t}
            confirm={confirm}
            onCancel={() => { setConfirm(null) }}
            onConfirm={() => {
              if (confirm.kind === 'remove') void confirmRemove(confirm.file)
              else {
                setConfirm(null)
                confirm.then()
              }
            }}
          />
        )}
    </div>
  )
}

/**
 * The grouped list of skills.
 * @param props - copy, the catalog state, the groups, and the pick action.
 * @returns the list body.
 */
function SkillList({ t, catalog, loaded, loadError, groups, query, selected, onPick }: {
  t: SkillsPageProps['t']
  catalog: SkillsCatalog
  loaded: boolean
  loadError: string | null
  groups: ReturnType<typeof groupSkills>
  query: string
  selected: string | undefined
  onPick: (file: string) => void
}) {
  if (loadError !== null) return <p className={css.notice} data-tone="error">{t('loadFailed', { message: loadError })}</p>
  if (!loaded) return <p className={css.notice}>{t('loading')}</p>
  if (catalog.skills.length === 0) return <p className={css.notice}>{t('empty')}</p>
  if (groups.length === 0 || groups.every(group => group.skills.length === 0)) return <p className={css.notice}>{query === '' ? t('empty') : t('noMatch')}</p>
  return (
    <div className={css.groups}>
      {groups.map(group => (
        <div key={group.root.path} className={css.group}>
          <h3 className={css.groupTitle} title={group.root.path}>
            {t(`source.${group.root.source}`)}
            {group.root.project === undefined ? null : <span className={css.project}>{basename(group.root.project)}</span>}
          </h3>
          <ul className={css.items}>
            {group.skills.map(skill => (
              <li key={skill.file}>
                <SkillRow t={t} skill={skill} selected={skill.file === selected} onPick={onPick} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

/**
 * The last segment of a path.
 * @param path - a Windows or POSIX path.
 * @returns its last segment.
 */
function basename(path: string): string {
  return path.replace(/[\\/]+$/u, '').replace(/^.*[\\/]/u, '')
}

/**
 * One skill in the list.
 * @param props - copy, the skill, whether it is selected, and the pick action.
 * @returns the row button.
 */
function SkillRow({ t, skill, selected, onPick }: {
  t: SkillsPageProps['t']
  skill: SkillEntry
  selected: boolean
  onPick: (file: string) => void
}) {
  const tags: string[] = []
  if (skill.problem !== undefined) tags.push(t('broken'))
  if (skill.shadowedBy !== undefined) tags.push(t('shadowed'))
  if (!skill.modelInvocable) tags.push(t('userOnly'))
  if (!skill.userInvocable) tags.push(t('hidden'))
  return (
    <button
      type="button"
      className={css.row}
      data-selected={selected ? 'true' : 'false'}
      data-problem={skill.problem === undefined ? undefined : 'true'}
      aria-current={selected ? 'true' : undefined}
      onClick={() => { onPick(skill.file) }}
    >
      <span className={css.rowName}>
        <IconSkillOutlineRegular size={14} />
        <span className={css.rowText}>{skill.name}</span>
      </span>
      {skill.description === '' ? null : <span className={css.rowDescription}>{skill.description}</span>}
      {tags.length === 0 ? null : <span className={css.rowTags}>{tags.map(tag => <span key={tag} className={css.tag}>{tag}</span>)}</span>}
    </button>
  )
}

/** Editor props. */
interface EditorProps {
  t: SkillsPageProps['t']
  draft: Draft
  document: SkillDocument | null
  roots: readonly SkillRootView[]
  dirty: boolean
  busy: boolean
  status: Status
  onChange: (draft: Draft) => void
  onSave: () => void
  onRevert: () => void
  onRemove: (file: string) => void
  onCopy: (root: string, opened: SkillDocument) => void
}

/**
 * The skill editor: name, description, switches, location, and instructions.
 * @param props - the draft and its actions.
 * @returns the form.
 */
function Editor({ t, draft, document, roots, dirty, busy, status, onChange, onSave, onRevert, onRemove, onCopy }: EditorProps) {
  const readOnly = document !== null && !document.writable
  const isNew = draft.file === undefined
  const writable = roots.filter(root => root.writable)
  const copyRoot = defaultRoot(roots)
  const file = draft.file
  const set = (patch: Partial<Draft>): void => { onChange({ ...draft, ...patch }) }
  const field = (label: string, hint: string | null, control: ReactNode, id: string): ReactNode => (
    <div className={css.field}>
      <label className={css.label} htmlFor={id}>{label}</label>
      {control}
      {hint === null ? null : <p className={css.hint}>{hint}</p>}
    </div>
  )
  return (
    // Implicit submission only fires while the enabled save button is the form's default button.
    <form className={css.form} onSubmit={(event) => { event.preventDefault(); onSave() }}>
      {readOnly
        ? (
          <div className={css.banner}>
            <span>{t('readOnly')}</span>
            {copyRoot === undefined ? null : <Button variant="outline" onClick={() => { onCopy(copyRoot, document) }}>{t('duplicate')}</Button>}
          </div>
        )
        : null}
      {field(t('name'), t('nameHint'), (
        <input id="skills-studio-name" className={css.text} value={draft.name} readOnly={readOnly} spellCheck={false}
          onChange={(event) => { set({ name: event.target.value.toLowerCase().replace(/\s+/gu, '-') }) }} />
      ), 'skills-studio-name')}
      {field(t('description'), t('descriptionHint'), (
        <textarea id="skills-studio-description" className={css.area} rows={3} value={draft.description} readOnly={readOnly}
          onChange={(event) => { set({ description: event.target.value }) }} />
      ), 'skills-studio-description')}
      {field(t('whenToUse'), null, (
        <input id="skills-studio-when" className={css.text} value={draft.whenToUse} readOnly={readOnly}
          onChange={(event) => { set({ whenToUse: event.target.value }) }} />
      ), 'skills-studio-when')}
      {isNew && writable.length > 1
        ? field(t('location'), null, (
          <select id="skills-studio-root" className={css.text} value={draft.root} onChange={(event) => { set({ root: event.target.value }) }}>
            {writable.map(root => <option key={root.path} value={root.path}>{`${t(`source.${root.source}`)} — ${root.path}`}</option>)}
          </select>
        ), 'skills-studio-root')
        : null}
      <div className={css.switches}>
        <div className={css.switchRow}>
          <span>{t('userInvocable')}</span>
          <Switch checked={draft.userInvocable} disabled={readOnly} label={t('userInvocable')} onChange={(next) => { set({ userInvocable: next }) }} />
        </div>
        <div className={css.switchRow}>
          <span>{t('modelInvocable')}</span>
          <Switch checked={draft.modelInvocable} disabled={readOnly} label={t('modelInvocable')} onChange={(next) => { set({ modelInvocable: next }) }} />
        </div>
      </div>
      {field(t('body'), t('bodyHint'), (
        <textarea id="skills-studio-body" className={`${css.area} ${css.body}`} value={draft.body} readOnly={readOnly} spellCheck={false}
          onChange={(event) => { set({ body: event.target.value }) }} />
      ), 'skills-studio-body')}
      {readOnly
        ? null
        : (
          <div className={css.footer}>
            {status === null ? <span className={css.dirty}>{dirty && !isNew ? t('unsaved') : ''}</span> : <span className={css.status} data-tone={status.tone}>{status.text}</span>}
            <div className={css.buttons}>
              {file === undefined
                ? null
                : <Button variant="ghost" className={css.danger} onClick={() => { onRemove(file) }} disabled={busy}>{t('remove')}</Button>}
              {isNew ? null : <Button variant="outline" onClick={onRevert} disabled={!dirty || busy}>{t('revert')}</Button>}
              <Button variant="primary" type="submit" disabled={!dirty || busy}>{isNew ? t('create') : t('save')}</Button>
            </div>
          </div>
        )}
      {readOnly && status !== null ? <p className={css.status} data-tone={status.tone}>{status.text}</p> : null}
    </form>
  )
}

/**
 * The Skill Builder column: the embedded chat, or its starting and failed states.
 * @param props - the page props and the builder state.
 * @returns the column body.
 */
function BuilderColumn({
  t, view, SessionProvider, renderSlot, openBuilder, freshBuilder, closeBuilder,
}: SkillsPageProps & { view: BuilderView<SessionReference> }) {
  return (
    <>
      <div className={css.builderHeader}>
        <div className={css.heading}>
          <h3 className={css.builderTitle}>{t('builder.title')}</h3>
          <p className={css.hint}>{t('builder.lead')}</p>
        </div>
        <div className={css.builderActions}>
          <Button variant="ghost" onClick={freshBuilder} disabled={view.kind === 'starting'}>{t('builder.new')}</Button>
          <Button variant="ghost" onClick={closeBuilder} aria-label={t('builder.close')}>×</Button>
        </div>
      </div>
      <div className={css.builderBody}>
        {view.kind === 'starting' ? <p className={css.notice}>{t('builder.starting')}</p> : null}
        {view.kind === 'failed'
          ? (
            <div className={css.notice} data-tone="error">
              <p>{t('builder.failed', { message: view.message })}</p>
              <Button variant="outline" onClick={() => { closeBuilder(); openBuilder() }}>{t('builder.retry')}</Button>
            </div>
          )
          : null}
        {view.kind === 'open'
          ? (
            <SessionProvider session={view.reference}>
              {renderSlot('skillsStudio.builder.conversation', {})}
            </SessionProvider>
          )
          : null}
      </div>
    </>
  )
}

/**
 * The discard and delete questions.
 * @param props - copy, the question, the skill's name, and the answers.
 * @returns the dialog.
 */
function ConfirmDialog({ t, confirm, onCancel, onConfirm }: {
  t: SkillsPageProps['t']
  confirm: Confirm
  onCancel: () => void
  onConfirm: () => void
}) {
  const removing = confirm.kind === 'remove'
  const label = confirm.name
  return (
    <Modal
      open
      onClose={onCancel}
      title={removing ? t('removeTitle', { name: label }) : t('discardTitle')}
      closeLabel={t('cancel')}
      description={removing ? t('removeBody') : t('discardBody', { name: label === '' ? t('new') : label })}
      footer={(
        <div className={css.dialogFooter}>
          <Button variant="ghost" onClick={onCancel} data-modal-autofocus="">{removing ? t('cancel') : t('keep')}</Button>
          <Button variant="primary" className={removing ? css.dangerFill : undefined} onClick={onConfirm}>{removing ? t('remove') : t('discard')}</Button>
        </div>
      )}
    />
  )
}

/**
 * The sidebar's skills glyph.
 * @param props - the size the sidebar asks for.
 * @returns the icon.
 */
export function SkillsPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <IconSkillOutlineRegular size={size} />
}
