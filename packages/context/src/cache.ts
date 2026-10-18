/** A Map that keeps at most `cap` entries, dropping the least recently used one first. */
export class Lru<K, V> {
  private readonly map = new Map<K, V>()
  constructor(private readonly cap: number) {}

  get(key: K): V | undefined {
    const v = this.map.get(key)
    if (v === undefined) return undefined
    // Re-insert: Map iteration order is insertion order, so the front is the oldest.
    this.map.delete(key)
    this.map.set(key, v)
    return v
  }

  set(key: K, value: V): void {
    this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.cap) this.map.delete(this.map.keys().next().value as K)
  }

  delete(key: K): void {
    this.map.delete(key)
  }

  get size(): number {
    return this.map.size
  }
}

/** Projects (roots) whose listings, graphs and settings are kept at once. */
export const MAX_ROOTS = 8
