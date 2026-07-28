/** Minimal counting semaphore; no dependency needed for this much. */
export class Semaphore {
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve))
    }
    this.active += 1
    let released = false
    return () => {
      // Guard against a double release returning a permit that was never held.
      if (released) return
      released = true
      this.active -= 1
      this.waiting.shift()?.()
    }
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    const release = await this.acquire()
    try {
      return await task()
    } finally {
      release()
    }
  }
}

/**
 * Keeps one semaphore per engine.
 *
 * Engines have very different safe concurrencies — Keynote drives a single
 * foreground document and must never run two at once, while reading notes out
 * of a zip is happily parallel — so a single global limit would either serialise
 * everything or corrupt Keynote exports.
 */
export class SemaphoreGroup {
  private readonly byKey = new Map<string, Semaphore>()

  get(key: string, limit: number): Semaphore {
    let semaphore = this.byKey.get(key)
    if (!semaphore) {
      semaphore = new Semaphore(limit)
      this.byKey.set(key, semaphore)
    }
    return semaphore
  }
}
