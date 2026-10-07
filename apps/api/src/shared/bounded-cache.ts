/**
 * `map.set` that keeps the map under `max` entries. A cache keyed on a value an
 * attacker chooses (a sandbox id in a URL, a host label in a TLS-check query)
 * grows without bound otherwise. At the cap it drops the oldest-inserted tenth:
 * a `Map` iterates in insertion order, so the head is the oldest.
 */
export function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  if (map.size >= max && !map.has(key)) {
    let drop = Math.ceil(max / 10);
    for (const oldest of map.keys()) {
      map.delete(oldest);
      if (--drop <= 0) break;
    }
  }
  map.set(key, value);
}
