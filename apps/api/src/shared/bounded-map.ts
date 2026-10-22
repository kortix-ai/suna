/**
 * A Map that holds at most `max` entries: setting a new key past the cap evicts
 * the oldest one. Replica-local caches keyed by session, project or conversation
 * live for the days a task runs; without a cap they grow with every key served.
 */
export class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly max: number) {
    super();
  }

  override set(key: K, value: V): this {
    if (super.has(key)) super.delete(key);
    super.set(key, value);
    if (this.size > this.max) super.delete(this.keys().next().value as K);
    return this;
  }
}
