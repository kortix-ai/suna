/**
 * Saved work for text that grows at its end, as a streaming reply does, keyed
 * by the text prefix the work covers. A call whose text starts with a saved
 * prefix resumes there instead of starting over.
 *
 * It keeps up to `max` prefixes, one per text that streams or re-renders: the
 * segments of one reply, and the replies and thoughts on screen. The least
 * recently used one is dropped. A miss only costs a full pass.
 */
export class PrefixCache<T> {
  private entries: { prefix: string; value: T }[] = [];

  constructor(private readonly max = 8) {}

  /** The saved entry with the longest prefix that `text` starts with. */
  find(text: string): { prefix: string; value: T } | undefined {
    let best = -1;
    for (let index = 0; index < this.entries.length; index += 1) {
      const { prefix } = this.entries[index];
      if ((best === -1 || prefix.length > this.entries[best].prefix.length) && text.startsWith(prefix)) best = index;
    }
    if (best === -1) return undefined;
    const [entry] = this.entries.splice(best, 1);
    this.entries.push(entry);
    return entry;
  }

  /** Saves `value` for `prefix`. It replaces the entries `prefix` extends. */
  set(prefix: string, value: T): void {
    this.entries = this.entries.filter((entry) => !prefix.startsWith(entry.prefix));
    this.entries.push({ prefix, value });
    if (this.entries.length > this.max) this.entries.shift();
  }
}
