/**
 * Keeping the operator's window in front while the test instance starts.
 *
 * A new Electron window takes the foreground, and with it the keyboard: keys the
 * operator types into their own Desktop window land in the test window instead.
 * On Windows the launch records the foreground window before starting the copy
 * and gives it back once the copy's window is up.
 *
 * @module @deepseek-ai/dsh-harness-dev-tools/focus
 */

import { spawnSync } from 'node:child_process'

/** Runs PowerShell and answers its standard output; tests replace it. */
export type PowerShell = (script: string) => string

/**
 * Run one PowerShell script without a window.
 * @param script - the script.
 * @returns its trimmed standard output, or empty on failure.
 */
export const powershell: PowerShell = (script) => {
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', timeout: 10_000 })
  return typeof result.stdout === 'string' ? result.stdout.trim() : ''
}

/** The user32 calls both scripts use. */
const USER32 = `Add-Type -Namespace DshFocus -Name W -MemberDefinition @'
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool IsWindow(System.IntPtr h);
[DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, System.IntPtr e);
'@`

/**
 * The window that has the foreground now.
 * @param run - runs PowerShell.
 * @param platform - the operating system.
 * @returns its handle, or undefined off Windows or when it cannot be read.
 */
export function foregroundWindow(run: PowerShell = powershell, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== 'win32') return undefined
  const out = run(`${USER32}\n[DshFocus.W]::GetForegroundWindow().ToInt64()`)
  return /^[1-9]\d*$/u.test(out) ? out : undefined
}

/**
 * Give the foreground back to a window. Windows lets a background process do
 * that only right after a key event, so a released Alt press precedes the call.
 * @param handle - the window from {@link foregroundWindow}.
 * @param run - runs PowerShell.
 * @returns whether the window has the foreground afterwards.
 */
export function restoreForeground(handle: string | undefined, run: PowerShell = powershell): boolean {
  if (handle === undefined || !/^\d+$/u.test(handle)) return false
  const out = run(`${USER32}
$h = [System.IntPtr]::new([long]${handle})
if (-not [DshFocus.W]::IsWindow($h)) { 'gone'; return }
[DshFocus.W]::keybd_event(0x12, 0, 0, [System.IntPtr]::Zero); [DshFocus.W]::keybd_event(0x12, 0, 2, [System.IntPtr]::Zero)
[void][DshFocus.W]::SetForegroundWindow($h)
[DshFocus.W]::GetForegroundWindow() -eq $h`)
  return out.endsWith('True')
}
