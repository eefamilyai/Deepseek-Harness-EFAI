/**
 * Stop-sequence filtering for a streamed reply.
 *
 * The upstream has no stop support, so the only place to honour one is while
 * relaying: keep any tail that is a prefix of a stop string until more text
 * arrives or the stream ends.
 *
 * @module dswg/util/stop
 */

export class StopFilter {
  #pending = ''
  #stopped = false

  readonly stops: string[]

  /**
   * @param stops - the configured stop sequences.
   */
  constructor(stops: string[]) {
    this.stops = stops
  }

  /** True when a stop sequence was emitted and the reply should end. */
  get stopped(): boolean {
    return this.#stopped
  }

  /**
   * Feed text.
   * @param text - the new text.
   * @returns the text safe to relay.
   */
  push(text: string): string {
    if (this.#stopped || this.stops.length === 0) return this.#stopped ? '' : text
    this.#pending += text
    for (const stop of this.stops) {
      const at = this.#pending.indexOf(stop)
      if (at !== -1) {
        const out = this.#pending.slice(0, at)
        this.#pending = ''
        this.#stopped = true
        return out
      }
    }
    let holdback = 0
    for (const stop of this.stops) {
      for (let length = Math.min(stop.length - 1, this.#pending.length); length > holdback; length -= 1) {
        if (this.#pending.endsWith(stop.slice(0, length))) {
          holdback = length
          break
        }
      }
    }
    const emit = this.#pending.slice(0, this.#pending.length - holdback)
    this.#pending = this.#pending.slice(emit.length)
    return emit
  }

  /**
   * Flush at the end of the stream.
   * @returns any held text that was not a stop sequence.
   */
  flush(): string {
    if (this.#stopped) return ''
    const out = this.#pending
    this.#pending = ''
    return out
  }
}
