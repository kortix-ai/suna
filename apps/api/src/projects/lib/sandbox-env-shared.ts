import { and, eq, sql } from 'drizzle-orm';
import { sessionSandboxes } from '@kortix/db';
import { db } from '../../shared/db';
import { config } from '../../config';
import { resolveLlmGatewayBaseUrl } from '../../llm-gateway/sandbox-base-url';
import type { ProviderName } from '../../platform/providers';
import type { SandboxEnvSnapshot } from './snapshot';

export function llmGatewayBaseUrlForProvider(_providerName: ProviderName): string {
  return resolveLlmGatewayBaseUrl(config.KORTIX_URL);
}

/**
 * Record which model route this box is on. ONE conditional statement: the flag
 * is merged into `config` in the database, and the row is only touched when the
 * stored value actually differs. This ran as a read plus an unconditional
 * rewrite of the identical value on EVERY prompt — two round trips to change
 * nothing in the steady state. `updated_at` still moves per prompt through the
 * turn-ledger writes, so nothing that watches the row for activity loses a
 * signal.
 */
export async function markSandboxLlmGatewayMode(
  sessionId: string,
  enabled: boolean,
): Promise<void> {
  await db
    .update(sessionSandboxes)
    .set({
      config: sql`COALESCE(${sessionSandboxes.config}, '{}'::jsonb) || jsonb_build_object('llmGatewayEnabled', ${enabled}::boolean)`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(sessionSandboxes.sessionId, sessionId),
        sql`(${sessionSandboxes.config}->>'llmGatewayEnabled') IS DISTINCT FROM ${String(enabled)}`,
      ),
    );
}

export function emptySandboxEnvSnapshot(reason: string): SandboxEnvSnapshot {
  return {
    env: {},
    names: [],
    revision: `${reason}-${Date.now()}`,
    scope: 'inherit',
    capabilitiesJson: '{"version":1,"capabilities":[]}',
  };
}

export async function runBounded<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}
