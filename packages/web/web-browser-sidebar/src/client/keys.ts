/**
 * Key names as the model writes them, translated to Electron input events.
 *
 * The model names keys the way `KeyboardEvent.key` and Playwright do (`Enter`,
 * `ArrowDown`, `Control+A`); Electron's `sendInputEvent` names them as accelerator
 * key codes (`Return`… `Down`). A printable key also needs a `char` event, which is
 * what inserts it and what a form listens to for Enter.
 *
 * @module @deepseek-ai/dsh-web-browser-sidebar/keys
 */

/** Model-facing names whose Electron key code differs. */
const KEY_CODES: Readonly<Record<string, string>> = {
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  escape: 'Escape',
  esc: 'Escape',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  space: 'Space',
  ' ': 'Space',
  insert: 'Insert',
}

/** Modifier names, as Electron's `modifiers` array spells them. */
const MODIFIERS: Readonly<Record<string, string>> = {
  control: 'control',
  ctrl: 'control',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  meta: 'meta',
  command: 'meta',
  cmd: 'meta',
}

/** The character a key types, for the keys that type one. */
function typedCharacter(code: string): string | undefined {
  if (code === 'Enter') return '\r'
  if (code === 'Space') return ' '
  return code.length === 1 ? code : undefined
}

/**
 * The input events that press and release one key, with any modifiers held.
 * @param combo - a key name, optionally prefixed by modifiers: `Enter`, `ArrowDown`, `Control+A`.
 * @returns keyDown, an optional char, and keyUp events for `sendInputEvent`.
 * @throws Error when the combination names no key.
 */
export function keyEvents(combo: string): Record<string, unknown>[] {
  const parts = combo.split('+').map(part => part.trim()).filter(part => part.length > 0)
  if (combo.trim() === '+') parts.push('+')
  const keyName = parts.pop()
  if (keyName === undefined) throw new Error('press needs a key name such as Enter or Tab')
  const modifiers = parts.map((part) => {
    const modifier = MODIFIERS[part.toLowerCase()]
    if (modifier === undefined) throw new Error(`"${part}" is not a modifier key; use Control, Shift, Alt, or Meta`)
    return modifier
  })
  const keyCode = KEY_CODES[keyName.toLowerCase()] ?? (/^f\d{1,2}$/iu.test(keyName) ? keyName.toUpperCase() : keyName)
  const events: Record<string, unknown>[] = [{ type: 'keyDown', keyCode, modifiers }]
  // A held Control or Meta makes the key a shortcut, which types nothing.
  const character = modifiers.some(modifier => modifier === 'control' || modifier === 'meta') ? undefined : typedCharacter(keyCode)
  if (character !== undefined) events.push({ type: 'char', keyCode: character, modifiers })
  events.push({ type: 'keyUp', keyCode, modifiers })
  return events
}
