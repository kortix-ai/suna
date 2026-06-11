/**
 * Daytona sandbox provider.
 *
 * Creates sandboxes in Daytona Cloud from a pre-built snapshot.
 * Extracted from the original account.ts provisioning logic.
 */

import { getDaytona, getDaytonaWarm } from '../../shared/daytona';
import { warmDaemonStartCommands } from '../../snapshots/warm-bake';
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
        // Idle → stop (hibernate, disk kept). Stopped → archive to cold storage
        // (disk still kept, resumable). NEVER auto-delete: a sandbox is only ever
        // removed when a user explicitly deletes the session. -1 disables Daytona
        // auto-delete explicitly so no account-level default can drop a box.
        autoStopInterval: opts.autoStopInterval ?? 15,
        autoArchiveInterval: 30,
        autoDeleteInterval: -1,
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

    // Daytona's experimental memory-snapshot restore is non-deterministic: ~half
    // the boxes come up WITHOUT the baked runtime (the filesystem layer is
    // dropped, leaving ~the bare base image). Verify the runtime is present; on
    // a bad restore, delete + recreate. After the cap, give up so the caller
    // falls back to the normal Dockerfile path rather than booting a broken box.
    const MAX_WARM_ATTEMPTS = 4;
    let sb: Awaited<ReturnType<typeof daytona.create>> | null = null;
    for (let attempt = 1; attempt <= MAX_WARM_ATTEMPTS; attempt++) {
      const box = await daytona.create(
        {
          snapshot: warmBaseSnapshot,
          autoStopInterval: opts.autoStopInterval ?? 15,
          autoArchiveInterval: 30,
          autoDeleteInterval: -1,
          public: false,
        },
        { timeout },
      );
      if (await DaytonaProvider.warmRuntimePresent(box)) {
        sb = box;
        break;
      }
      console.warn(
        `[daytona] warm box ${box.id} restored without runtime ` +
        `(experimental snapshot flakiness) — attempt ${attempt}/${MAX_WARM_ATTEMPTS}, recreating`,
      );
      await box.delete().catch(() => {});
    }
    if (!sb) {
      throw new WarmRuntimeUnavailableError(
        `warm base ${warmBaseSnapshot} restored without runtime after ${MAX_WARM_ATTEMPTS} attempts`,
      );
    }

    // A memory-snapshot restore brings back the VM's FROZEN clock (stuck at bake
    // time — hours behind). That breaks elapsed-time UI and, worse, time-based
    // checks (JWT/token expiry, TLS cert validity). Reset to real wall-clock
    // time before anything else runs. Best-effort.
    await sb.process
      .executeCommand(`sudo date -s @${Math.floor(Date.now() / 1000)} >/dev/null 2>&1 || true`, undefined, undefined, 15)
      .catch(() => {});

    const { writeEnv, startDaemon } = warmDaemonStartCommands(envVars);
    const wrote = await sb.process.executeCommand(writeEnv, undefined, undefined, 30);
    if (!(wrote.result ?? '').includes('wrote')) {
      throw new Error(`[daytona] warm create: failed to write session env (${(wrote.result ?? '').slice(0, 200)})`);
    }
    await sb.process.executeCommand(startDaemon, undefined, undefined, 30);

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

  /**
   * True iff the baked Kortix runtime survived the warm-snapshot restore. The
   * experimental region drops the filesystem layer ~half the time, so a restored
   * box may be missing the daemon/entrypoint binaries entirely — booting it would
   * fail with "kortix-entrypoint: No such file or directory". Cheap probe before
   * we commit to a warm box.
   */
  private static async warmRuntimePresent(sb: { process: { executeCommand: (c: string, cwd?: string, env?: Record<string, string>, t?: number) => Promise<{ result?: string }> } }): Promise<boolean> {
    try {
      const r = await sb.process.executeCommand(
        'test -x /usr/local/bin/kortix-agent && test -x /usr/local/bin/kortix-entrypoint && command -v opencode >/dev/null && echo ok',
        undefined,
        undefined,
        30,
      );
      return (r.result ?? '').includes('ok');
    } catch {
      return false;
    }
  }

  async start(externalId: string): Promise<void> {
    const daytona = getDaytona();
    const sandbox = await daytona.get(externalId);
    await sandbox.start();
  }

  async stop(externalId: string): Promise<void> {
    const daytona = getDaytona();
    const sandbox = await daytona.get(externalId);
    await sandbox.stop();
  }

  async remove(externalId: string): Promise<void> {
    const daytona = getDaytona();
    const sandbox = await daytona.get(externalId);
    await daytona.delete(sandbox);
  }

  async getStatus(externalId: string): Promise<SandboxStatus> {
    try {
      const daytona = getDaytona();
      const sandbox = await daytona.get(externalId);
      const state = String(sandbox.state ?? '').toLowerCase();
      if (state.includes('start') || state.includes('running') || state.includes('active')) return 'running';
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
