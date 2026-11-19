export class BoundedTtlCache<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt: number }>();

  constructor(readonly maxEntries: number, private readonly now: () => number = Date.now) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error('cache capacity must be a positive integer');
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) { this.entries.delete(key); return undefined; }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs: number): void {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error('cache TTL must be a positive integer');
    this.pruneExpired();
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }

  delete(key: K, expected?: V): boolean {
    if (expected !== undefined && this.entries.get(key)?.value !== expected) return false;
    return this.entries.delete(key);
  }

  get size(): number { this.pruneExpired(); return this.entries.size; }

  private pruneExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
  }
}
