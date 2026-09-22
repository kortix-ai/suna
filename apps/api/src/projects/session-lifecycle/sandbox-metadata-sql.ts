import { sessionSandboxes } from '@kortix/db';
import { sql, type SQL } from 'drizzle-orm';

/**
 * `coalesce(metadata, '{}') - 'a' - 'b' - …`, generated from a key list.
 *
 * Hand-written `-` chains are how the readiness clocks drifted apart: the wake
 * claim stripped four of the ten, `clearRuntimeReadinessClocks` stripped eight
 * by hardcoded index, and `opencodeBootWaitFirstSeenAt` was therefore cleared
 * by nothing except a human Restart. That immortal clock parked session
 * 29861dfa's second attempt 14 ms before its daemon claimed its first turn
 * (2026-08-26). One generator, one list, no drift.
 */
export function stripMetadataKeys(keys: readonly string[]): SQL {
  return keys.reduce<SQL>((acc, key) => {
    // A LITERAL, not a bind parameter. `jsonb - $1` leaves the parameter type
    // unknown and Postgres cannot choose between `jsonb - text` and
    // `jsonb - integer`. Every key here is a compile-time constant from a
    // frozen list, and this guard keeps it that way.
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`refusing to strip a non-identifier metadata key: ${key}`);
    }
    return sql`${acc} - ${sql.raw(`'${key}'`)}`;
  }, sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb)`);
}

/**
 * The keys of `next` whose value differs from `previous`.
 *
 * Several writers compute a WHOLE metadata object from a row they read earlier
 * (`{ ...metadata, key: value }`). Writing that object back erases every key a
 * concurrent writer added after the read — a restart claim, an egress pin. Merge
 * only this delta with `||` instead (SESS-9, 2026-09).
 */
export function metadataDelta(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const delta: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(next)) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(value)) delta[key] = value;
  }
  return delta;
}
