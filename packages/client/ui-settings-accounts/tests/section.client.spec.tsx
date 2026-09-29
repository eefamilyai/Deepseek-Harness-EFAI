// @vitest-environment jsdom
/**
 * The Accounts section's removal: which answer deletes the browser profile.
 *
 * Removing a config slot is reversible by adding the login again. Deleting the
 * browser profile is not. The two therefore must never share one gesture, so
 * these cases pin the separation: the tick alone answers purge, the dialog only
 * answers "go ahead", and a row that is gone leaves no answer behind.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountsSection } from '../src/client/AccountsSection.tsx'
import type { AccountsSectionAccount, AccountsSectionComponentProps } from '../src/client/AccountsSection.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** The one pooled login these cases act on. */
const row: AccountsSectionAccount = {
  id: 'a-1',
  slug: 'slug-1',
  provider: 'kiln-deepseek',
  label: 'first@example.com',
  configured: true,
  fields: [{ label: 'Email', value: 'first@example.com' }],
}

/**
 * Render the section with inert stubs, apart from the account list and the
 * removal, which are the subject.
 * @param confirm - what the browser confirmation dialog answers.
 * @returns the removal spy, so a case can read the arguments it was called with.
 */
function renderSection(confirm: boolean): { readonly removeAccount: ReturnType<typeof vi.fn> } {
  vi.spyOn(window, 'confirm').mockReturnValue(confirm)
  const removeAccount = vi.fn(async () => ({ ok: true as const }))
  const props = {
    t: (key: string) => en[key as keyof typeof en],
    listProviders: async () => ['kiln-deepseek'],
    addAccount: async () => ({ ok: false as const, message: 'unused' }),
    // A stable answer, so the row comes back after a removal and the leftover
    // purge answer has something to leak into.
    listAccounts: async () => [row],
    reloginAccount: async () => ({ ok: false as const, message: 'unused' }),
    reprofileAccount: async () => ({ ok: false as const, message: 'unused' }),
    removeAccount,
    accountLog: async () => [],
  } as unknown as AccountsSectionComponentProps
  render(<AccountsSection {...props} />)
  return { removeAccount }
}

/** Expand the only row, which is what reveals its identity fields and its tick. */
async function expandRow(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: /first@example\.com/ }))
}

/**
 * The row's purge tick, as the DOM currently reports it.
 * @returns the checkbox's checked state.
 */
function purgeTick(): boolean {
  return (screen.getByRole('checkbox', { name: en['accounts.remove.purge'] }) as HTMLInputElement).checked
}

/** The row's Remove button. */
function removeButton(): HTMLElement {
  return screen.getByRole('button', { name: en['accounts.remove'] })
}

describe('AccountsSection removal', () => {
  it('offers the purge choice unticked, so a bare Remove keeps the profile', async () => {
    renderSection(true)
    await expandRow()

    expect(purgeTick()).toBe(false)
  })

  it('removes only the config slot when the tick is off', async () => {
    const { removeAccount } = renderSection(true)
    await expandRow()

    fireEvent.click(removeButton())

    await waitFor(() => { expect(removeAccount).toHaveBeenCalledTimes(1) })
    expect(window.confirm).toHaveBeenCalledWith(en['accounts.remove.confirm'])
    expect(removeAccount).toHaveBeenCalledWith('kiln-deepseek', 'a-1', 'slug-1', false)
  })

  it('deletes the profile only after the tick is set deliberately', async () => {
    const { removeAccount } = renderSection(true)
    await expandRow()

    fireEvent.click(screen.getByRole('checkbox', { name: en['accounts.remove.purge'] }))
    expect(purgeTick()).toBe(true)

    fireEvent.click(removeButton())

    await waitFor(() => { expect(removeAccount).toHaveBeenCalledTimes(1) })
    const prompt = vi.mocked(window.confirm).mock.calls[0]?.[0]
    expect(prompt).toContain(en['accounts.remove.purgeHint'])
    expect(removeAccount).toHaveBeenCalledWith('kiln-deepseek', 'a-1', 'slug-1', true)
  })

  it('removes nothing when the operator cancels the dialog', async () => {
    const { removeAccount } = renderSection(false)
    await expandRow()

    fireEvent.click(screen.getByRole('checkbox', { name: en['accounts.remove.purge'] }))
    fireEvent.click(removeButton())

    await waitFor(() => { expect(window.confirm).toHaveBeenCalled() })
    expect(removeAccount).not.toHaveBeenCalled()
  })

  it('drops a row\'s tick once it is gone, so a later row cannot inherit it', async () => {
    const { removeAccount } = renderSection(true)
    await expandRow()

    fireEvent.click(screen.getByRole('checkbox', { name: en['accounts.remove.purge'] }))
    fireEvent.click(removeButton())
    await waitFor(() => { expect(removeAccount).toHaveBeenCalledTimes(1) })

    // The list hands the same id back, so the row re-renders. Its removal
    // already settled, and the answer it carried must not survive it.
    await waitFor(() => { expect(purgeTick()).toBe(false) })

    fireEvent.click(removeButton())
    await waitFor(() => { expect(removeAccount).toHaveBeenCalledTimes(2) })
    expect(removeAccount).toHaveBeenLastCalledWith('kiln-deepseek', 'a-1', 'slug-1', false)
  })
})
