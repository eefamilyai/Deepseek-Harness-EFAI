/**
 * Environment scrubbing for the kernel child process.
 *
 * The model runs arbitrary Python inside the kernel by design — that is the
 * capability, not a bug. What it has no legitimate need for are the harness's
 * provider keys and auth tokens, which are consumed by the host process before
 * a cell ever runs. Removing them means a stray `print(os.environ)`, an
 * exception repr, or a library that logs its config cannot surface a real
 * credential in model context.
 *
 * This is a port of `scrub_child_env` in the Kiln runtime's `kernel.py`, applied
 * here because the harness spawns `kernel_child.py` directly rather than through
 * its Python parent.
 * @module @deepseek-ai/dsh-kernel-python/env
 */

/**
 * Names that look like secrets. Suffix matches catch the `*_API_KEY` /
 * `*_TOKEN` convention; the substring alternatives catch the fixed names that
 * carry no prefix.
 */
const SECRET_ENV_PATTERN = new RegExp([
  // Suffix convention: FOO_API_KEY, GH_TOKEN, DB_PASSWORD, and friends.
  '(_KEY|_TOKEN|_SECRET|_PASSWORD|_PASS|_COOKIE|_CREDENTIALS?|_AUTH)$',
  // Fixed names that carry no prefix to anchor on.
  '(API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|SECRET_KEY|PRIVATE_KEY|SESSION_COOKIE|SESSION_TOKEN|CREDENTIALS?)',
].join('|'), 'i')

/**
 * Whether an environment variable name looks like it carries a secret.
 * @param name - the variable name.
 * @returns true when the kernel child must not inherit it.
 */
export function isSecretEnvVar(name: string): boolean {
  return SECRET_ENV_PATTERN.test(name)
}

/**
 * Build the kernel child's environment: the host environment minus every
 * secret-looking variable, plus the caller's additions.
 *
 * The additions are applied *after* the filter deliberately — `KILN_STATE_DIR`
 * and friends are harness configuration, and one of them naming a path with
 * `_KEY` in it must not silently vanish.
 * @param source - the environment to derive from, normally `process.env`.
 * @param additions - harness-owned variables to set on the child.
 * @returns the scrubbed environment for the child process.
 */
export function scrubChildEnv(
  source: NodeJS.ProcessEnv,
  additions: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (isSecretEnvVar(name)) continue
    result[name] = value
  }
  // The kernel child is a Python process whose stdout is the cell's `out`.
  // Without a pinned encoding it inherits the host's, so on a Windows box
  // whose ANSI codepage is not UTF-8 a cell printing a non-ASCII character
  // emits that codepage's bytes and the UTF-8 reader replaces them with
  // U+FFFD. Callers' additions still win, since they are applied last.
  return { ...result, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...additions }
}
