/**
 * Concurrency and timing primitives.
 *
 * @module dswg/util/async
 */

/**
 * Resolve after a delay.
 * @param ms - milliseconds.
 * @param signal - optional abort signal that rejects the wait.
 * @returns a promise that settles after the delay.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** A counting semaphore with FIFO fairness. */
export class Semaphore {
  #free: number
  #waiters: Array<() => void> = []

  /**
   * @param permits - how many holders may run at once.
   */
  constructor(permits: number) {
    this.#free = Math.max(1, permits)
  }

  /** Wait for a permit. */
  async acquire(): Promise<void> {
    if (this.#free > 0) {
      this.#free -= 1
      return
    }
    await new Promise<void>((resolve) => this.#waiters.push(resolve))
  }

  /** Return a permit, waking the oldest waiter. */
  release(): void {
    const next = this.#waiters.shift()
    if (next) next()
    else this.#free += 1
  }

  /**
   * Run a function while holding a permit.
   * @param fn - the work.
   * @returns the function's value.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  /** Permits currently unused. */
  get available(): number {
    return this.#free
  }

  /** Callers waiting for a permit. */
  get waiting(): number {
    return this.#waiters.length
  }
}

/**
 * A promise together with the functions that settle it.
 *
 * @typeParam T - resolved value type.
 */
export class Deferred<T> {
  readonly promise: Promise<T>
  resolve!: (value: T | PromiseLike<T>) => void
  reject!: (reason?: unknown) => void

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
  }
}

/**
 * Reject a promise if it does not settle in time.
 * @param promise - the work.
 * @param ms - timeout in milliseconds.
 * @param label - used in the rejection message.
 * @returns the promise's value.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/** A bounded map that drops least-recently-used entries. */
export class Lru<K, V> {
  #map = new Map<K, V>()
  #capacity: number

  /**
   * @param capacity - maximum entries retained.
   */
  constructor(capacity: number) {
    this.#capacity = Math.max(1, capacity)
  }

  /**
   * Read a value, marking it recently used.
   * @param key - the key.
   * @returns the value, or undefined.
   */
  get(key: K): V | undefined {
    const value = this.#map.get(key)
    if (value !== undefined) {
      this.#map.delete(key)
      this.#map.set(key, value)
    }
    return value
  }

  /**
   * Insert or replace a value.
   * @param key - the key.
   * @param value - the value.
   */
  set(key: K, value: V): void {
    this.#map.delete(key)
    this.#map.set(key, value)
    while (this.#map.size > this.#capacity) {
      const oldest = this.#map.keys().next()
      if (oldest.done) break
      this.#map.delete(oldest.value)
    }
  }

  /**
   * Remove one entry.
   * @param key - the key.
   */
  delete(key: K): void {
    this.#map.delete(key)
  }

  /** Number of entries. */
  get size(): number {
    return this.#map.size
  }

  /** Entries, oldest first. */
  entries(): Array<[K, V]> {
    return [...this.#map.entries()]
  }
}
