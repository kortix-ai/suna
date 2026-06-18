/**
 * Daytona sandbox provider.
 *
 * Creates sandboxes in Daytona Cloud from a pre-built snapshot.
 * Extracted from the original account.ts provisioning logic.
 */

import { getDaytona, getDaytonaWarm } from '../../shared/daytona';
import { warmRestoreScript, WARM_RESTORE_MARKERS } from '../../snapshots/warm-bake';
import { serviceKeyForExternalId } from '../service-key';
import { config, SANDBOX_VERSION } from '../../config';
// (DAYTONA_SNAPSHOT was removed — every sandbox boots from its project's
// own per-project snapshot, resolved by the snapshot builder. Callers
// must pass `opts.snapshot`; there is no shared platform-wide image.)
import { WarmRuntimeUnavailableError } from './index';
import type {
  SandboxProvider,
  ProviderName,
  CreateSandboxOpts,
  ProvisionResult,
  SandboxStatus,
  ResolvedEndpoint,
  ProvisioningTraits,
  ProvisioningStatus,
} from './index';

// Short-TTL cache for getStatus on the session-open hot path. POST /sessions/:id/start
// is polled ~every 800ms and each poll did an UNCACHED daytona.get() (~150-600ms)
// just to confirm a freshly-claimed warm box is still running — pure overhead that
// dominates the warm-start server cost. Box state changes far slower than the poll
// cadence, so caching the 'running' verdict briefly collapses ~2/3 of those
// provider round-trips. Only 'running' is cached (never 'stopped'/'unknown'), so
// idle-stop / wake detection always reads fresh; start/stop/remove bust the entry.
const STATUS_CACHE_TTL_MS = 1500;
const runningStatusCache = new Map<string, number>(); // externalId → cachedAt (ms)

/**
 * Daytona sandbox lifecycle policy, applied as SDK create() params so a box
 * self-manages even when the API/tunnel that created it dies — orphaned
 * local-dev and ephemeral-env sessions are the dominant leak source, and the
 * idle sweep can't see boxes it has no DB row for.
 *
 *  - autoStopInterval: idle → stop (compute billing ends). CLAMPED to >= 1 so a
 *    box is NEVER created persistent. A 0 here (the old warm-pool "stay ready
 *    until claimed" value) leaked 500+ never-stopping boxes that nothing reaped.
 *    This is the setting that actually stops the money burn.
 *  - autoArchiveInterval: stopped → archived to cold storage after a few days
 *    (cheap, still resumable). Until then the stopped box stays warm-resumable.
 *  - autoDeleteInterval: -1 by default → NEVER auto-delete. An idle box is
 *    nearly free once stopped + cold-archived, so we never destroy its disk;
 *    a session is only removed when the user explicitly deletes it.
 */
export function daytonaLifecycle(autoStopOverride?: number): {
  autoStopInterval: number;
  autoArchiveInterval: number;
  autoDeleteInterval: number;
} {
  const stop = autoStopOverride ?? config.KORTIX_SANDBOX_AUTOSTOP_MINUTES;
  return {
    autoStopInterval: Math.max(1, stop || config.KORTIX_SANDBOX_AUTOSTOP_MINUTES || 15),
    autoArchiveInterval: config.KORTIX_SANDBOX_AUTOARCHIVE_MINUTES,
    autoDeleteInterval: config.KORTIX_SANDBOX_AUTODELETE_MINUTES,
  };
}

export class DaytonaProvider implements SandboxProvider {
  readonly name: ProviderName = 'daytona';

  readonly provisioning: ProvisioningTraits = {
    async: false,
    stages: [
      { id: 'creating', progress: 50, message: 'Creating sandbox...' },
    ],
  };

  async getProvisioningStatus(): Promise<ProvisioningStatus | null> {
    return null;
  }

  async create(opts: CreateSandboxOpts): Promise<ProvisionResult> {
    // KORTIX_URL is the public API base URL the sandbox calls back on. Strip
    // any route suffix so older env files that included /v1 or /v1/router still
    // resolve to the bare origin.
    const sandboxApiBase = config.KORTIX_URL
      .replace(/\/+$/, '')
      .replace(/\/v1\/router$/, '')
      .replace(/\/v1$/, '');

    const createTimeoutSeconds = Math.max(
      1,
      Number.parseInt(process.env.KORTIX_DAYTONA_CREATE_TIMEOUT_SECONDS || '30', 10) || 30,
    );

    const envVars: Record<string, string> = {
      // Guarantee the sandbox contract even if a caller forgets: the runtime only
      // needs KORTIX_API_URL + KORTIX_TOKEN; tools derive every router endpoint
      // from KORTIX_API_URL and auth with KORTIX_TOKEN.
      KORTIX_API_URL: `${sandboxApiBase}/v1`,
      // Session identity, git context, KORTIX_TOKEN, and the project's own
      // secrets (incl. provider keys set via `kortix providers`, picked up by
      // opencode at boot) — see buildSessionSandboxEnvVars() and
      // provisionSessionSandbox().
      ...opts.envVars,
    };
    if (!envVars.KORTIX_TOKEN) {
      throw new Error('[daytona] create() called without KORTIX_TOKEN — sandbox cannot authenticate to the Kortix router.');
    }

    // Experimental warm path: boot from the memory-state warm base on the WARM
    // target and start the daemon post-restore (see createWarm). ANY warm
    // failure — flaky restore, "Region not found" (the experimental region can
    // be revoked org-side at any time), env-write failure — surfaces as
    // WarmRuntimeUnavailableError so the session falls back to the normal
    // Dockerfile-snapshot path instead of erroring. Warm is best-effort, never
    // a hard dependency.
    if (opts.warmBaseSnapshot) {
      try {
        return await this.createWarm(opts, opts.warmBaseSnapshot, envVars, sandboxApiBase, createTimeoutSeconds);
      } catch (err) {
        if (err instanceof WarmRuntimeUnavailableError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new WarmRuntimeUnavailableError(`warm create failed: ${msg}`);
      }
    }

    // Every Daytona sandbox boots from its project's own per-project
    // snapshot (`kortix-snap-…`), resolved by the snapshot builder before
    // we get here (see platform/services/session-sandbox.ts +
    // snapshots/builder.ts). There is intentionally no shared platform
    // fallback: a missing snapshot means the project's first build
    // hasn't finished, which is a session-creation error — not something
    // we paper over with an unrelated image.
    const snapshot = opts.snapshot;
    if (!snapshot) {
      throw new Error(
        'Daytona create() called without opts.snapshot. ' +
        'Every sandbox must boot from a per-project snapshot built by ' +
        'apps/api/src/snapshots/builder.ts. There is no shared fallback.',
      );
    }

    const daytona = getDaytona();
    const daytonaSandbox = await daytona.create(
      {
        snapshot,
        envVars,
        // Idle → stop → archive → delete. See daytonaLifecycle(): auto-stop is
        // clamped to >= 1 so this box can never be created persistent, and a
        // finite auto-delete lets the SDK reclaim it if the API/tunnel that
        // created it dies. Intervals are env-tunable (KORTIX_SANDBOX_AUTO*).
        ...daytonaLifecycle(opts.autoStopInterval),
        public: false,
      },
      { timeout: createTimeoutSeconds },
    );

    const externalId = daytonaSandbox.id;
    const apiBase = sandboxApiBase;
    const baseUrl = `${apiBase}/v1/p/${externalId}/8000`;

    return {
      externalId,
      baseUrl,
      metadata: {
        provisionedBy: opts.userId,
        daytonaSandboxId: externalId,
        snapshot,
        version: SANDBOX_VERSION,
      },
    };
  }

  /**
   * Warm path: create from the experimental memory-state warm base (~1.3s) on
   * the WARM target, then start the session daemon post-restore. The daemon's
   * identity (KORTIX_TOKEN, repo, branch, …) is written to an env file the
   * daemon sources — create-time envVars don't survive a memory restore and the
   * entrypoint doesn't re-run, so we inject + launch here.
   */
  private async createWarm(
    opts: CreateSandboxOpts,
    warmBaseSnapshot: string,
    envVars: Record<string, string>,
    sandboxApiBase: string,
    timeout: number,
  ): Promise<ProvisionResult> {
    const daytona = getDaytonaWarm();

    // Daytona's experimental region is non-deterministic in TWO ways: creates
    // fail outright ("Sandbox failed to start: internal error"), and boxes that
    // do start can come up WITHOUT the baked runtime (filesystem layer dropped).
    // Retry through both; after the cap, give up so the caller falls back to the
    // normal Dockerfile path rather than booting a broken box.
    const MAX_WARM_ATTEMPTS = 4;
    let sb: Awaited<ReturnType<typeof daytona.create>> | null = null;
    let sawCreateFailure = false;
    let envWriteFailed = false;
    for (let attempt = 1; attempt <= MAX_WARM_ATTEMPTS; attempt++) {
      let box: Awaited<ReturnType<typeof daytona.create>> | null = null;
      try {
        box = await daytona.create(
          {
            snapshot: warmBaseSnapshot,
            ...daytonaLifecycle(opts.autoStopInterval),
            public: false,
          },
          { timeout },
        );
      } catch (err) {
        // The throw leaves an error-state box org-side that we have no handle
        // to — swept below once the loop settles.
        sawCreateFailure = true;
        console.warn(
          `[daytona] warm create attempt ${attempt}/${MAX_WARM_ATTEMPTS} failed:`,
          err instanceof Error ? err.message : err,
        );
        continue;
      }

      // ONE in-box round-trip does it all: probe the baked runtime, reset the
      // frozen clock, write the session env, and launch the daemon (was four
      // serial executeCommands). The decision is driven by PARSED MARKER STRINGS
      // (never exitCode — the SDK can return it undefined).
      let result = '';
      try {
        const script = warmRestoreScript(envVars, Math.floor(Date.now() / 1000));
        const r = await box.process.executeCommand(script, undefined, undefined, 60);
        result = r.result ?? '';
      } catch (err) {
        // Box unreachable / command failed mid-flight — treat like a dropped
        // restore and recreate (don't trust a half-initialized box).
        console.warn(
          `[daytona] warm restore attempt ${attempt}/${MAX_WARM_ATTEMPTS} command failed:`,
          err instanceof Error ? err.message : err,
        );
        await box.delete().catch(() => {});
        continue;
      }

      if (result.includes(WARM_RESTORE_MARKERS.noRuntime)) {
        console.warn(
          `[daytona] warm box ${box.id} restored without runtime ` +
          `(experimental snapshot flakiness) — attempt ${attempt}/${MAX_WARM_ATTEMPTS}, recreating`,
        );
        await box.delete().catch(() => {});
        continue;
      }
      if (!result.includes(WARM_RESTORE_MARKERS.wrote) || !result.includes(WARM_RESTORE_MARKERS.started)) {
        // Runtime WAS present (no recreate marker) but the env write or daemon
        // launch didn't confirm — not a flaky-restore case, so don't burn
        // retries; surface a hard error (the caller falls back to the cold path).
        envWriteFailed = true;
        await box.delete().catch(() => {});
        break;
      }
      sb = box; // KORTIX_WROTE + KORTIX_STARTED both seen → committed.
      break;
    }
    if (sawCreateFailure) {
      // Fire-and-forget: clear the error-state corpses failed creates left in
      // the org (targeted by warm-base snapshot name + error state).
      void import('../../snapshots/warm-bake')
        .then(({ reapErroredWarmBoxes }) => reapErroredWarmBoxes(warmBaseSnapshot, (l) => console.log(l)))
        .catch(() => {});
    }
    if (envWriteFailed) {
      throw new Error('[daytona] warm create: session env write / daemon launch did not confirm');
    }
    if (!sb) {
      throw new WarmRuntimeUnavailableError(
        `warm base ${warmBaseSnapshot} unavailable after ${MAX_WARM_ATTEMPTS} attempts (create failures and/or dropped-runtime restores)`,
      );
    }

    const externalId = sb.id;
    const baseUrl = `${sandboxApiBase}/v1/p/${externalId}/8000`;
    return {
      externalId,
      baseUrl,
      metadata: {
        provisionedBy: opts.userId,
        daytonaSandboxId: externalId,
        snapshot: warmBaseSnapshot,
        warm: true,
        version: SANDBOX_VERSION,
      },
    };
  }

  async start(externalId: string): Promise<void> {
    runningStatusCache.delete(externalId);
    const daytona = getDaytona();
    const sandbox = await daytona.get(externalId);
    await sandbox.start();
  }

  async stop(externalId: string): Promise<void> {
    runningStatusCache.delete(externalId);
    const daytona = getDaytona();
    const sandbox = await daytona.get(externalId);
    await sandbox.stop();
  }

  async remove(externalId: string): Promise<void> {
    runningStatusCache.delete(externalId);
    const daytona = getDaytona();
    const sandbox = await daytona.get(externalId);
    await daytona.delete(sandbox);
  }

  async getStatus(externalId: string): Promise<SandboxStatus> {
    const cachedAt = runningStatusCache.get(externalId);
    if (cachedAt !== undefined && Date.now() - cachedAt < STATUS_CACHE_TTL_MS) return 'running';
    try {
      const daytona = getDaytona();
      const sandbox = await daytona.get(externalId);
      const state = String(sandbox.state ?? '').toLowerCase();
      if (state.includes('start') || state.includes('running') || state.includes('active')) {
        runningStatusCache.set(externalId, Date.now());
        return 'running';
      }
      runningStatusCache.delete(externalId);
      if (state.includes('stop') || state.includes('archive')) return 'stopped';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async resolvePreviewLink(externalId: string, port: number): Promise<{ url: string; token: string | null }> {
    const daytona = getDaytona();
    const sandbox = await daytona.get(externalId);
    const link = await (sandbox as any).getPreviewLink(port);
    return { url: (link.url || String(link)).replace(/\/$/, ''), token: link.token || null };
  }

  async resolveEndpoint(externalId: string): Promise<ResolvedEndpoint> {
    const daytona = getDaytona();
    const sandbox = await daytona.get(externalId);
    const link = await (sandbox as any).getPreviewLink(8000);
    const url = (link.url || String(link)).replace(/\/$/, '');
    const token = link.token || null;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Daytona-Skip-Preview-Warning': 'true',
      'X-Daytona-Disable-CORS': 'true',
    };
    if (token) {
      headers['X-Daytona-Preview-Token'] = token;
    }

    // Look up the service key (sandboxes OR session_sandboxes) to authenticate to the sandbox.
    try {
      const serviceKey = await serviceKeyForExternalId(externalId);
      if (serviceKey) {
        headers['Authorization'] = `Bearer ${serviceKey}`;
      }
    } catch (err) {
      console.warn(`[DAYTONA] Failed to look up service key for ${externalId}:`, err);
    }

    return { url, headers };
  }

  async ensureRunning(externalId: string): Promise<void> {
    const status = await this.getStatus(externalId);
    if (status === 'running') return;
    console.log(`[DAYTONA] Sandbox ${externalId} is ${status}, waking up...`);
    await this.start(externalId);
  }
}
