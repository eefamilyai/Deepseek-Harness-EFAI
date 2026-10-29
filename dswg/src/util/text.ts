/**
 * Text utilities used by the tool-call parser and the account identifier rules.
 *
 * @module dswg/util/text
 */

/**
 * Levenshtein edit distance, bounded for short strings.
 * @param a - first string.
 * @param b - second string.
 * @returns the distance.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(
        (current[j - 1] as number) + 1,
        (previous[j] as number) + 1,
        (previous[j - 1] as number) + cost,
      )
    }
    previous = current
  }
  return previous[b.length] as number
}

/**
 * Normalize a tool or parameter name for comparison: lowercase, camelCase split,
 * everything but letters and digits dropped.
 * @param name - raw name.
 * @returns the comparable form.
 */
export function normalizeName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/**
 * Uppercase the first letter of a string.
 * @param text - input.
 * @returns the capitalized string.
 */
export function capitalize(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1)
}

/**
 * True when a string is only whitespace (or empty).
 * @param text - input.
 * @returns whether it is blank.
 */
export function isBlank(text: string): boolean {
  return text.trim().length === 0
}

/**
 * Truncate to a maximum length, marking the cut.
 * @param text - input.
 * @param max - maximum characters kept.
 * @returns the possibly shortened text.
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…(+${text.length - max})`
}


/**
 * The user agent to send on the account's behalf.
 *
 * Headless Chromium puts `HeadlessChrome/…` where a browser puts `Chrome/…`, and
 * the site reads that string from the page as well as from every request header.
 * An account whose traffic says "headless" is an account the anti-abuse stack
 * can single out without any other evidence, so the token is removed: the rest of
 * the string — the real version, the real platform — is the profile's own.
 * @param userAgent - the user agent as the browser reports it, if any.
 * @returns the user agent to use, or null when there is none.
 */
export function browserUserAgent(userAgent: string | null | undefined): string | null {
  if (userAgent === null || userAgent === undefined) return null
  const cleaned = userAgent.replace(/HeadlessChrome/g, 'Chrome').trim()
  return cleaned.length === 0 ? null : cleaned
}
