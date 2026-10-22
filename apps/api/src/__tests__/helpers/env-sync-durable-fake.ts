/**
 * The `session_sandboxes.config` merges `env-sync-durable-state.ts` writes,
 * applied to an in-memory config, for suites that fake `shared/db`.
 *
 * `syncSandboxEnvForPrompt` trusts its per-replica memo only while the durable
 * record names the same signature, so a fake `db` that drops these writes
 * models a database that loses every confirmed push: no prompt is ever trusted.
 *
 * The writes are drizzle `SQL` fragments. Their `queryChunks` interleave the
 * literal text with the bound values, so each value is the chunk after the
 * LAST text chunk that names its key (a key can appear twice: the object key
 * and a `->>` read).
 */
import { Param, SQL } from 'drizzle-orm';

function valueAfterKey(fragment: SQL, key: string): unknown {
  const chunks = fragment.queryChunks;
  let value: unknown;
  for (let i = 0; i < chunks.length; i++) {
    const text = (chunks[i] as { value?: unknown }).value;
    if (Array.isArray(text) && text.join('').includes(key)) value = chunks[i + 1];
  }
  return value;
}

/**
 * The first string a `where` binds, or null: the session id of
 * `eq(sessionSandboxes.sessionId, id)`, the key every env-sync read and write
 * uses. A suite with more than one session keys its fake rows by it.
 */
export function firstBoundString(where: unknown): string | null {
  if (!(where instanceof SQL)) return null;
  for (const chunk of where.queryChunks) {
    if (chunk instanceof Param && typeof chunk.value === 'string') return chunk.value;
    const nested = firstBoundString(chunk);
    if (nested) return nested;
  }
  return null;
}

/**
 * `config` with one env-sync write applied, or `config` itself when `fragment`
 * is another write (`llmGatewayEnabled`, a plain object patch). The boot write
 * keeps the larger value, as its SQL `GREATEST` does.
 */
export function applyEnvSyncDurableWrite(
  config: Record<string, unknown> | null,
  fragment: unknown,
): Record<string, unknown> | null {
  if (!(fragment instanceof SQL)) return config;
  const signature = valueAfterKey(fragment, 'envSyncSignature');
  if (signature !== undefined) {
    return {
      ...config,
      envSyncSignature: signature,
      envSyncAppliedAtMs: valueAfterKey(fragment, 'envSyncAppliedAtMs'),
      envSyncRecordVersion: valueAfterKey(fragment, 'envSyncRecordVersion'),
    };
  }
  const bootAtMs = valueAfterKey(fragment, 'envSyncDaemonBootAtMs');
  if (typeof bootAtMs === 'number') {
    const prior = config?.envSyncDaemonBootAtMs;
    return {
      ...config,
      envSyncDaemonBootAtMs: typeof prior === 'number' ? Math.max(prior, bootAtMs) : bootAtMs,
    };
  }
  return config;
}
