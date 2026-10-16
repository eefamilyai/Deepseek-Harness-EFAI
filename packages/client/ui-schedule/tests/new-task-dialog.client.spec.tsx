// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { NewTaskDialog } from '../src/client/NewTaskDialog.tsx'
import { en } from '../src/client/task-manager-locales.ts'

/** Two Sessions the form can bind the new task to. */
const SESSIONS = [
  { id: 'session-1' as SessionId, label: 'Release checks' },
  { id: 'session-2' as SessionId, label: 'Notes' },
] as const

afterEach(() => { cleanup() })

/** Render the dialog with settled defaults and return its collaborators. */
function mount(options: {
  readonly sessions?: readonly { readonly id: SessionId; readonly label: string }[]
  readonly sessionsLoading?: boolean
  readonly outcome?: { readonly ok: true } | { readonly ok: false; readonly message: keyof typeof en }
} = {}) {
  const onSubmit = vi.fn(async () => options.outcome ?? { ok: true })
  const onClose = vi.fn()
  render(<NewTaskDialog
    sessions={options.sessions ?? SESSIONS}
    sessionsLoading={options.sessionsLoading ?? false}
    zone="UTC"
    onSubmit={onSubmit}
    onClose={onClose}
    t={makeTranslate(en)}
  />)
  return { onSubmit, onClose }
}

/** Fill the two free-text fields the form always shows. */
function fillContent(title = 'Nightly sweep', prompt = 'Summarize the logs'): void {
  fireEvent.change(screen.getByLabelText(en['detail.name']), { target: { value: title } })
  fireEvent.change(screen.getByLabelText(en['detail.instruction']), { target: { value: prompt } })
}

describe('New task dialog', () => {
  it('stages a name, an instruction, a Session, and one recurrence rule', () => {
    mount()
    expect(screen.getByRole('dialog', { name: en['create.title'] })).toBeDefined()
    expect(screen.getByLabelText(en['detail.name'])).toBeDefined()
    expect(screen.getByLabelText(en['detail.instruction'])).toBeDefined()
    // The Session row shows the first available Session's own label, and the
    // Repeat row shows the choice the form opens on.
    expect(screen.getByRole('button', { name: new RegExp(en['create.session']) }).textContent)
      .toContain('Release checks')
    expect(screen.getByRole('button', { name: new RegExp(en['rule.repeat']) }).textContent)
      .toContain(en['rule.daily'])
  })

  it('creates the staged task in the chosen Session and closes on success', async () => {
    const h = mount()
    fillContent()
    fireEvent.click(screen.getByRole('button', { name: en['create.confirm'] }))
    await waitFor(() => { expect(h.onClose).toHaveBeenCalledOnce() })
    expect(h.onSubmit).toHaveBeenCalledWith({
      sessionId: 'session-1',
      title: 'Nightly sweep',
      prompt: 'Summarize the logs',
      daily: { time: expect.stringMatching(/^\d{2}:\d{2}:00$/), time_zone: 'UTC' },
    })
  })

  it('binds the task to the Session the reader picks from the list', async () => {
    const h = mount()
    fillContent()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(en['create.session']) }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Notes' }))
    fireEvent.click(screen.getByRole('button', { name: en['create.confirm'] }))
    await waitFor(() => { expect(h.onSubmit).toHaveBeenCalledOnce() })
    expect(h.onSubmit.mock.calls[0]?.[0]).toMatchObject({ sessionId: 'session-2' })
  })

  it('names a refused rule and keeps every staged value', async () => {
    const h = mount({ outcome: { ok: false, message: 'timing.notFuture' } })
    fillContent()
    fireEvent.click(screen.getByRole('button', { name: en['create.confirm'] }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', en['timing.notFuture'])
    expect(h.onClose).not.toHaveBeenCalled()
    // The draft the reader typed is still there to correct.
    expect(screen.getByLabelText<HTMLInputElement>(en['detail.name']).value).toBe('Nightly sweep')
  })

  it('refuses an empty name before the request reaches the Host', () => {
    const h = mount()
    fireEvent.click(screen.getByRole('button', { name: en['create.confirm'] }))
    expect(screen.getByRole('alert').textContent).toBe(en['rule.invalidTitle'])
    expect(h.onSubmit).not.toHaveBeenCalled()
  })

  it('offers no creation while the Session catalog is empty', () => {
    mount({ sessions: [] })
    expect(screen.getByRole('button', { name: en['create.confirm'] })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: new RegExp(en['create.session']) }).textContent)
      .toContain(en['create.sessionEmpty'])
  })

  it('states that the catalog is still loading rather than that no Session exists', () => {
    mount({ sessions: [], sessionsLoading: true })
    expect(screen.getByRole('button', { name: new RegExp(en['create.session']) }).textContent)
      .toContain(en['create.sessionLoading'])
  })
})
