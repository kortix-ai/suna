import { and, eq } from 'drizzle-orm';
import { sessionSandboxes } from '@kortix/db';
import { db } from '../../lib/db';
import { resolveSandboxIngress } from '../../sandbox-proxy/backend';
import { config } from '../../lib/config';
import type { ProviderName } from '../../platform/providers';
import { createCoalescedRunner } from './env-sync-coalescer';
import { resolveSessionNetworkBoundary } from '../secrets/network-secret-boundary';
import { loadSessionSecretContext } from '../sessions/session-secret-context';
import { sandboxBelongsToThisInstance } from '../sessions/instance-scope';
import {
  resolveSandboxEnvSnapshot,
  syncProviderNetworkBoundary,
  type SandboxEnvSnapshot,
} from './sandbox-env-snapshot';
import {
  FANOUT_CONCURRENCY,
  SANDBOX_SERVICE_PORT,
  postEnvToDaemon,
  runBounded,
} from './sandbox-env-push';

export interface ProjectSecretPropagationTarget {
  session_id: string;
  sandbox_id: string | null;
  status: 'synced' | 'failed';
  scope: SandboxEnvSnapshot['scope'] | null;
  revision: string | null;
  exported: number;
  managed: number | null;
  withheld: number | null;
  agent_env_written: boolean;
  reason?: string;
}

export interface ProjectSecretPropagationResult {
  ok: boolean;
  active_sandboxes: number;
  targeted: number;
  synced: number;
  failed: number;
  exported: number;
  results: ProjectSecretPropagationTarget[];
}

/**
 * The coalesced public entry — see env-sync-coalescer.ts for the incident this
 * exists for (2026-08-21: looping secret writers × per-write fan-out throttled
 * the whole Daytona org). Callers keep their await semantics: an awaited call
 * returns a report from a run that STARTED after their write, so the report
 * covers it; a burst shares one trailing run instead of stacking N fan-outs.
 */
export const propagateProjectSecretsToActiveSandboxes = createCoalescedRunner<
  ProjectSecretPropagationResult
>({
  run: (projectId, opts) => runProjectSecretPropagation(projectId, opts),
  // 3s, not more: single-flight + burst-collapse are what break a storm (50
  // writes → 2 runs regardless of this value); the interval only paces a
  // slow-drip loop. The two AWAITED callers (secret-broker rotation and
  // POST /secrets/sync) sit behind this cooldown too, so it must stay small
  // enough that a human never notices it on those endpoints.
  minIntervalMs: () => {
    const configured = Number((config as any).KORTIX_ENV_SYNC_MIN_INTERVAL_MS);
    return Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : 3_000;
  },
});

/**
 * Re-push ONE session's secrets into its own sandbox — what an agent session
 * gets from `POST /secrets/sync`. It is the same per-session work the
 * pre-prompt env sync does on every prompt, so it grants the agent nothing new;
 * it only lets the agent pull a just-changed secret or grant mid-turn. It never
 * touches another session's box: the project-wide fan-out stays a person's
 * action (d649d08932, finding F6). Not coalesced — one box, one push.
 */
export function syncSessionSecretsToSandbox(
  projectId: string,
  sessionId: string,
): Promise<ProjectSecretPropagationResult> {
  return runProjectSecretPropagation(projectId, { sessionId });
}

async function runProjectSecretPropagation(
  projectId: string,
  opts?: { refreshModels?: boolean; sessionId?: string },
): Promise<ProjectSecretPropagationResult> {
  const report: ProjectSecretPropagationResult = {
    ok: true,
    active_sandboxes: 0,
    targeted: 0,
    synced: 0,
    failed: 0,
    exported: 0,
    results: [],
  };
  try {
    const allRows = await db
      .select({
        externalId: sessionSandboxes.externalId,
        sessionId: sessionSandboxes.sessionId,
        provider: sessionSandboxes.provider,
        config: sessionSandboxes.config,
        metadata: sessionSandboxes.metadata,
      })
      .from(sessionSandboxes)
      .where(
        and(
          eq(sessionSandboxes.projectId, projectId),
          eq(sessionSandboxes.status, 'active'),
          ...(opts?.sessionId ? [eq(sessionSandboxes.sessionId, opts.sessionId)] : []),
        ),
      );
    // INSTANCE SCOPE (shared local DB — ../instance-scope.ts): a box another
    // API instance provisioned must not receive THIS instance's env (its
    // `KORTIX_URL`-derived gateway URL). No-op when KORTIX_INSTANCE_ID is unset.
    // A session-scoped sync re-checks the session in code too: the guarantee
    // that it never reaches another session's box must not rest on one WHERE.
    const rows = allRows
      .filter((r) => sandboxBelongsToThisInstance(r.metadata))
      .filter((r) => !opts?.sessionId || r.sessionId === opts.sessionId);

    report.active_sandboxes = rows.length;
    const targets = rows.filter((r): r is typeof r & { externalId: string } => !!r.externalId);
    for (const row of rows) {
      if (row.externalId) continue;
      report.results.push({
        session_id: row.sessionId,
        sandbox_id: null,
        status: 'failed',
        scope: null,
        revision: null,
        exported: 0,
        managed: null,
        withheld: null,
        agent_env_written: false,
        reason: 'active sandbox has no external id',
      });
    }
    report.targeted = targets.length;
    if (targets.length === 0) {
      console.info('[env-sync] propagate: no active sandboxes found', { projectId, totalRows: rows.length });
      report.failed = report.results.length;
      report.ok = report.failed === 0;
      return report;
    }
    console.info('[env-sync] propagate: pushing to sandboxes', { projectId, targetCount: targets.length });

    await runBounded(targets, FANOUT_CONCURRENCY, async (row) => {
      const config = (row.config || {}) as Record<string, unknown>;
      const serviceKey = typeof config.serviceKey === 'string' ? config.serviceKey : null;
      if (!serviceKey) {
        report.results.push({
          session_id: row.sessionId,
          sandbox_id: row.externalId,
          status: 'failed',
          scope: null,
          revision: null,
          exported: 0,
          managed: null,
          withheld: null,
          agent_env_written: false,
          reason: 'active sandbox has no service key',
        });
        return;
      }
      let snapshot: SandboxEnvSnapshot | null = null;
      try {
        // One read of the session's secret context for both.
        const secretContext = loadSessionSecretContext(projectId, row.sessionId);
        snapshot = await resolveSandboxEnvSnapshot(projectId, row.sessionId, undefined, secretContext);
        if (!snapshot) throw new Error('session env snapshot is unavailable');
        const providerName = row.provider as ProviderName;
        const networkBoundary = await resolveSessionNetworkBoundary(projectId, row.sessionId, undefined, secretContext);
        // No wait budget and no fail-soft here. This is the secret-CRUD fan-out:
        // it is the path that DELIVERS a rotated credential to the edge, and its
        // caller reports the per-sandbox outcome to the author who just saved the
        // secret. An arming failure has to be visible there, so it stays a
        // `status: 'failed'` row rather than a warning nobody reads.
        await syncProviderNetworkBoundary(providerName, row.externalId, networkBoundary);
        const { url, headers } = await resolveSandboxIngress(row.externalId, { port: SANDBOX_SERVICE_PORT, transport: 'http' });
        const proof = await postEnvToDaemon({
          previewUrl: url,
          providerHeaders: headers,
          serviceKey,
          snapshot,
          refreshModels: opts?.refreshModels,
          requireAgentEnvProof: true,
        });
        report.results.push({
          session_id: row.sessionId,
          sandbox_id: row.externalId,
          status: 'synced',
          scope: snapshot.scope,
          revision: proof.revision,
          exported: proof.exported,
          managed: proof.managed,
          withheld: proof.withheld,
          agent_env_written: proof.agentEnvWritten,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        report.results.push({
          session_id: row.sessionId,
          sandbox_id: row.externalId,
          status: 'failed',
          scope: snapshot?.scope ?? null,
          revision: snapshot?.revision ?? null,
          exported: 0,
          managed: null,
          withheld: null,
          agent_env_written: false,
          reason,
        });
        console.warn(
          `[env-sync] hot push failed for sandbox ${row.externalId}:`,
          reason,
        );
      }
    });
    report.synced = report.results.filter((result) => result.status === 'synced').length;
    report.failed = report.results.filter((result) => result.status === 'failed').length;
    report.exported = report.results.reduce((sum, result) => sum + result.exported, 0);
    report.results.sort((a, b) => a.session_id.localeCompare(b.session_id));
    report.ok = report.failed === 0;
    console.info('[env-sync] propagate: complete', {
      projectId,
      activeSandboxes: report.active_sandboxes,
      targeted: report.targeted,
      synced: report.synced,
      failed: report.failed,
      exported: report.exported,
    });
    return report;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[env-sync] hot fan-out failed for project ${projectId}:`,
      reason,
    );
    report.ok = false;
    report.failed += 1;
    report.results.push({
      session_id: '',
      sandbox_id: null,
      status: 'failed',
      scope: null,
      revision: null,
      exported: 0,
      managed: null,
      withheld: null,
      agent_env_written: false,
      reason,
    });
    return report;
  }
}
