/**
 * Gateway-URL convergence at API boot.
 *
 * THE PROBLEM (2026-08-22, evening, repeatedly). A sandbox's OpenCode is
 * configured at boot with `KORTIX_LLM_BASE_URL` derived from the API's
 * `KORTIX_URL` (`llm-gateway/sandbox-base-url.ts`). When that URL dies — on dev
 * the cloudflared quick tunnel rotates and the launcher watchdog respawns the
 * API with a NEW `KORTIX_URL` — every running box keeps calling the dead URL
 * until its NEXT prompt's env sync (`syncSandboxEnvForPrompt` → daemon
 * `/kortix/env` → OpenCode reload) rewrites it. The first prompt after a
 * rotation therefore fails inside OpenCode with APIError `Cannot connect to
 * API: Unable to connect. Is the computer able to access the url?` (or
 * statusCode 530, message `<none>`), and the transcript shows a bare error row.
 *
 * THE FIX. `provisionSessionSandbox` stamps `metadata.kortixUrl` (the origin
 * the box's gateway URL was derived from — `projects/gateway-url-stamp.ts`).
 * Once, after the server is listening, this module selects the ACTIVE boxes
 * this instance provisioned whose stamp differs from the current `KORTIX_URL`
 * and pushes the live gateway URL through the SAME `/kortix/env` push the
 * per-prompt path uses (`refreshModels: true` restarts OpenCode so the new
 * base URL takes), then re-stamps the row. Bounded concurrency, fail-soft per
 * box, one summary line.
 *
 * PROD IS A NO-OP: one stable `KORTIX_URL`, so every row's stamp equals it and
 * nothing is selected (asserted in `gateway-url-convergence.test.ts`).
 */
import { eq, sql } from 'drizzle-orm';
import { sessionSandboxes } from '@kortix/db';
import { db } from '../../shared/db';
import { resolveSandboxIngress } from '../../sandbox-proxy/backend';
import { serviceKeyForExternalId } from '../../platform/service-key';
import type { ProviderName } from '../../platform/providers';
import { sandboxBelongsToThisInstance } from '../instance-scope';
import {
  SANDBOX_KORTIX_URL_METADATA_KEY,
  currentKortixUrl,
  sandboxKortixUrl,
} from '../gateway-url-stamp';
import {
  SANDBOX_SERVICE_PORT,
  emptySandboxEnvSnapshot,
  llmGatewayBaseUrlForProvider,
  postEnvToDaemon,
  resolveSandboxEnvSnapshot,
  runBounded,
} from './sandbox-env-sync';

const CONVERGENCE_CONCURRENCY = 6;

export interface GatewayUrlConvergenceReport {
  /** Active rows of this instance whose stamp differs from the current KORTIX_URL. */
  candidates: number;
  converged: number;
  failed: number;
}

/**
 * Re-push the live gateway URL to every active sandbox of this instance that
 * still carries a stale `metadata.kortixUrl`. Never throws.
 */
export async function convergeActiveSandboxGatewayUrl(opts: {
  reason: string;
}): Promise<GatewayUrlConvergenceReport> {
  const report: GatewayUrlConvergenceReport = { candidates: 0, converged: 0, failed: 0 };
  const current = currentKortixUrl();
  if (!current) return report;

  type Candidate = {
    sandboxId: string;
    externalId: string;
    sessionId: string;
    projectId: string;
    provider: string;
    config: Record<string, unknown> | null;
    metadata: Record<string, unknown> | null;
  };
  let candidates: Candidate[];
  try {
    const rows = await db
      .select({
        sandboxId: sessionSandboxes.sandboxId,
        externalId: sessionSandboxes.externalId,
        sessionId: sessionSandboxes.sessionId,
        projectId: sessionSandboxes.projectId,
        provider: sessionSandboxes.provider,
        config: sessionSandboxes.config,
        metadata: sessionSandboxes.metadata,
      })
      .from(sessionSandboxes)
      .where(eq(sessionSandboxes.status, 'active'));
    candidates = rows.filter((row): row is typeof row & { externalId: string } => {
      if (!row.externalId) return false;
      // INSTANCE SCOPE (shared local DB — ../instance-scope.ts): never touch a
      // box another API instance provisioned. No-op when KORTIX_INSTANCE_ID is unset.
      if (!sandboxBelongsToThisInstance(row.metadata)) return false;
      const stamped = sandboxKortixUrl(row.metadata);
      // Unstamped (legacy) rows: we cannot tell which origin they were booted
      // with, and their next prompt's env sync converges them anyway. Skip.
      if (stamped === null) return false;
      return stamped !== current;
    }) as Candidate[];
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[gateway-url-convergence] select failed (reason=${opts.reason}):`, reason);
    return report;
  }
  report.candidates = candidates.length;

  if (candidates.length > 0) {
    await runBounded(candidates, CONVERGENCE_CONCURRENCY, async (row) => {
      try {
        const rowConfig = (row.config || {}) as Record<string, unknown>;
        const serviceKey =
          (typeof rowConfig.serviceKey === 'string' && rowConfig.serviceKey) ||
          (await serviceKeyForExternalId(row.externalId));
        if (!serviceKey) throw new Error('active sandbox has no service key');
        // The project env when the session has one; the empty snapshot when it
        // does not — the push is about the gateway URL, not the secrets, and
        // the daemon only re-applies what changed.
        const snapshot =
          (await resolveSandboxEnvSnapshot(row.projectId, row.sessionId)) ??
          emptySandboxEnvSnapshot('gateway-url-convergence');
        const { url, headers } = await resolveSandboxIngress(row.externalId, {
          port: SANDBOX_SERVICE_PORT,
          transport: 'http',
        });
        await postEnvToDaemon({
          previewUrl: url,
          providerHeaders: headers,
          serviceKey,
          snapshot,
          // The new base URL reaches OpenCode only through a respawn.
          refreshModels: true,
          llmGatewayEnabled: true,
          llmGatewayBaseUrl: llmGatewayBaseUrlForProvider(row.provider as ProviderName),
        });
        await db
          .update(sessionSandboxes)
          .set({
            metadata: sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) || ${JSON.stringify({ [SANDBOX_KORTIX_URL_METADATA_KEY]: current })}::jsonb`,
            updatedAt: new Date(),
          })
          .where(eq(sessionSandboxes.sandboxId, row.sandboxId));
        report.converged += 1;
        console.info(
          `[gateway-url-convergence] converged sandbox=${row.externalId} from=${sandboxKortixUrl(row.metadata)} to=${current}`,
        );
      } catch (err) {
        report.failed += 1;
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(
          `[gateway-url-convergence] push failed sandbox=${row.externalId} (stamp=${sandboxKortixUrl(row.metadata)}):`,
          reason,
        );
      }
    });
  }

  console.log(
    `[gateway-url-convergence] reason=${opts.reason} kortixUrl=${current} candidates=${report.candidates} converged=${report.converged} failed=${report.failed}`,
  );
  return report;
}
