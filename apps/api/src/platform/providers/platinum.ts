/**
 * Platinum sandbox provider.
 *
 * Provisions Cloud Hypervisor microVMs via the Platinum REST API. Mirrors the
 * Daytona provider's contract one-for-one; the only differences are Platinum's
 * request shapes:
 *   - create boots from a per-project TEMPLATE (opts.snapshot = a Platinum
 *     template id/name) with `?wait_for_state=running` so create returns a
 *     running sandbox synchronously (provisioning.async = false, like Daytona).
 *   - the agent port (8000) is reached through Platinum's edge via a PUBLIC
 *     expose URL; the sandbox itself is gated by the KORTIX serviceKey bearer
 *     (added as a header in resolveEndpoint, same effective auth as Daytona).
 */

import { platinumJson } from '../../shared/platinum';
import { serviceKeyForExternalId } from '../service-key';
import { sandboxFrontendBaseUrl } from '../sandbox-frontend-url';
import { config, SANDBOX_VERSION } from '../../config';
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

const AGENT_PORT = 8000;

interface PlatinumSandbox {
  id: string;
  state?: string;
}
type PlatinumExposedPort = { port: number; url: string; token?: string; public: boolean };

function isMissingSandboxError(error: unknown): boolean {
  const err = error as
    | { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown }
    | null
    | undefined;
  if (err?.status === 404 || err?.statusCode === 404) return true;
  const code = typeof err?.code === 'string' ? err.code.toLowerCase() : '';
  if (code === 'not_found' || code === 'notfound') return true;
  const message =
    typeof err?.message === 'string'
      ? err.message.toLowerCase()
      : String(error ?? '').toLowerCase();
  return (
    message.includes('-> 404') ||
    message.includes('"code":"not_found"') ||
    message.includes('not found') ||
    message.includes('no such sandbox') ||
    message.includes('sandbox does not exist')
  );
}

export class PlatinumProvider implements SandboxProvider {
  readonly name: ProviderName = 'platinum';

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
    // Boot from the session's own per-project template if one was built
    // (opts.snapshot), else fall back to the fixed PLATINUM_TEMPLATE (e.g.
    // kortix-computer) — so Platinum works out of the box without a per-project
    // build. At least one must be set.
    const template = opts.snapshot ?? config.PLATINUM_TEMPLATE;
    if (!template) {
      throw new Error(
        'Platinum create() has no template: pass opts.snapshot or set PLATINUM_TEMPLATE ' +
        '(a ready Platinum template id, e.g. kortix-computer).',
      );
    }

    const sandboxApiBase = config.KORTIX_URL
      .replace(/\/+$/, '')
      .replace(/\/v1\/router$/, '')
      .replace(/\/v1$/, '');

    const envVars: Record<string, string> = {
      KORTIX_API_URL: `${sandboxApiBase}/v1`,
      // Frontend base for user-facing dashboard links (never the API host).
      KORTIX_FRONTEND_URL: sandboxFrontendBaseUrl(),
      ...opts.envVars,
    };
    if (!envVars.KORTIX_SANDBOX_TOKEN) {
      throw new Error('[platinum] create() called without KORTIX_SANDBOX_TOKEN — sandbox cannot authenticate to the Kortix router.');
    }

    // autoStopInterval maps to Platinum's auto_stop_minutes. 0 → persistent
    // (never auto-stops); >0 → ephemeral with that idle timeout.
    //
    // Platinum now AUTO-STOPS idle boxes natively (idle timeout) and resumes them
    // CoW on reopen. The old reason for forcing persistent (the CH UFFD demand-paged
    // device-resume bug, isolated 2026-06-06, which wedged net+vsock on resume) is
    // FIXED — the CH v52 UFFD patch landed; verified stop→resume ~2.3s with the guest
    // alive. Relying on Platinum's own timer makes idle-stop robust (no dependency on
    // the Kortix maintenance reaper, which when down let boxes run 24/7 and flood the
    // host). A normal session gets KORTIX_SANDBOX_AUTOSTOP_MINUTES.
    const autoStop = opts.autoStopInterval ?? config.KORTIX_SANDBOX_AUTOSTOP_MINUTES;

    const _t0 = Date.now();
    // This asks Platinum to long-poll server-side for up to 60s
    // (wait_timeout_ms) — platinumJson's default 20s client-side abort budget
    // would cut that off early, so pass an explicit signal comfortably longer
    // than the server-side wait instead of relying on the default.
    const sandbox = await platinumJson<PlatinumSandbox>(
      '/v1/sandboxes?wait_for_state=running&wait_timeout_ms=60000',
      {
        method: 'POST',
        signal: AbortSignal.timeout(70_000),
        body: JSON.stringify({
          template,
          envVars,
          type: autoStop === 0 ? 'persistent' : 'ephemeral',
          auto_stop_minutes: autoStop,
        }),
      },
    );
    const _vmMs = Date.now() - _t0;

    const externalId = sandbox.id;
    const baseUrl = `${sandboxApiBase}/v1/p/${externalId}/${AGENT_PORT}`;

    // Eagerly expose the agent port so the *.sbx edge route is LIVE the moment
    // the sandbox is running — before the FE connects. Expose is otherwise lazy
    // (first /v1/p request triggers it), which left a window where the FE's
    // /agent, /session, /global/events calls hit an un-routed edge → 504s right
    // after runtime-ready. Best-effort: a failure here just falls back to the
    // lazy expose in resolveEndpoint.
    let exposedUrl = '';
    const _tExpose0 = Date.now();
    try {
      const exposed = await platinumJson<PlatinumExposedPort>(`/v1/sandboxes/${externalId}/expose`, {
        method: 'POST',
        body: JSON.stringify({ port: AGENT_PORT, public: true }),
      });
      exposedUrl = (exposed.url ?? '').replace(/\/$/, '');
    } catch (err) {
      console.warn(`[platinum] eager expose ${externalId}:${AGENT_PORT} failed (lazy fallback):`, err);
    }
    const _exposeMs = Date.now() - _tExpose0;

    // Return as soon as the VM is running and the agent port is exposed — do NOT
    // block on the in-guest runtime (repo clone + opencode). That readiness is
    // polled by the frontend (useOpenCodeRuntimeReady + the react-query
    // "opencode not ready" retry) EXACTLY as it is for Daytona, whose create()
    // also returns a not-yet-usable box and defers readiness to the FE.
    //
    // Why this matters: the old code polled /kortix/health for runtimeReady up
    // to 75s here. Under a restored-VM virtio-net RX stall the clone can hang,
    // so that poll burned the full 75s and surfaced as the dreaded provision
    // timeout. Returning at vm-running makes the 75s timeout IMPOSSIBLE (we never
    // poll) and — since a Platinum restore resumes in ~50ms — create() returns in
    // ~1s, FASTER than Daytona's cloud-start. The daemon's clone-retry +
    // transfer-stall-timeout (kortix-sandbox-agent-server) recover any transient
    // clone stall in the background while the FE waits, so the session still
    // becomes usable without any create-path hang.
    console.log(
      `[platinum-timing] ${externalId} vm-running=${_vmMs}ms expose=${_exposeMs}ms ` +
      `edge=${exposedUrl ? 'ready' : 'lazy'} total=${Date.now() - _t0}ms (runtime-ready deferred to FE poll, like daytona)`,
    );

    return {
      externalId,
      baseUrl,
      metadata: {
        provisionedBy: opts.userId,
        platinumSandboxId: externalId,
        template,
        version: SANDBOX_VERSION,
      },
    };
  }

  async start(externalId: string): Promise<void> {
    await platinumJson(`/v1/sandboxes/${externalId}/start`, { method: 'POST' });
  }

  async stop(externalId: string): Promise<void> {
    await platinumJson(`/v1/sandboxes/${externalId}/stop`, { method: 'POST' });
  }

  async remove(externalId: string): Promise<void> {
    await platinumJson(`/v1/sandboxes/${externalId}`, { method: 'DELETE' });
  }

  async getStatus(externalId: string): Promise<SandboxStatus> {
    try {
      const sandbox = await platinumJson<PlatinumSandbox>(`/v1/sandboxes/${externalId}`);
      const state = String(sandbox.state ?? '').toLowerCase();
      if (state === 'running') return 'running';
      if (state === 'stopped' || state === 'stopping' || state.includes('archiv')) return 'stopped';
      if (state === 'deleted' || state === 'failed-start' || state === 'lost') return 'removed';
      return 'unknown'; // provisioning / starting / resuming / migrating — transitional
    } catch (err) {
      if (isMissingSandboxError(err)) return 'removed';
      return 'unknown';
    }
  }

  async resolvePreviewLink(externalId: string, port: number): Promise<{ url: string; token: string | null }> {
    // Expose the requested port through Platinum's edge → https://<port>-<id>.sbx…
    // No preview token: the sandbox is gated by the serviceKey bearer the proxy
    // already adds. Idempotent — re-exposing returns the same URL.
    const exposed = await platinumJson<PlatinumExposedPort>(
      `/v1/sandboxes/${externalId}/expose`,
      { method: 'POST', body: JSON.stringify({ port, public: true }) },
    );
    const url = (exposed.url ?? '').replace(/\/$/, '');
    if (!url) throw new Error(`[platinum] expose returned no URL for ${externalId}:${port}`);
    return { url, token: null };
  }

  async resolveEndpoint(externalId: string): Promise<ResolvedEndpoint> {
    // Expose the agent port through Platinum's edge. PUBLIC (no HMAC ?t= token)
    // because Platinum's edge reads the token from the query string only, which
    // doesn't compose with the Kortix proxy appending a path — and the sandbox
    // is already gated by the KORTIX serviceKey bearer below (same effective
    // auth as Daytona's preview link + serviceKey). Idempotent: re-exposing an
    // already-exposed port returns the same URL.
    // POST /:id/expose takes a SINGLE {port,public} and returns a single
    // {url,port,...} — the array {expose:[...]} shape is only valid on the
    // create route's inline expose. Sending the array here 400s.
    const exposed = await platinumJson<PlatinumExposedPort>(
      `/v1/sandboxes/${externalId}/expose`,
      { method: 'POST', body: JSON.stringify({ port: AGENT_PORT, public: true }) },
    );
    const url = (exposed.url ?? '').replace(/\/$/, '');
    if (!url) throw new Error(`[platinum] expose returned no URL for ${externalId}:${AGENT_PORT}`);

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    try {
      const serviceKey = await serviceKeyForExternalId(externalId);
      if (serviceKey) headers['Authorization'] = `Bearer ${serviceKey}`;
    } catch (err) {
      console.warn(`[PLATINUM] Failed to look up service key for ${externalId}:`, err);
    }

    return { url, headers };
  }

  async ensureRunning(externalId: string): Promise<void> {
    const status = await this.getStatus(externalId);
    if (status === 'running') return;
    // Only a stopped sandbox can be started; poking a transitional one would
    // 409. Anything else we leave to settle / to the reconciler.
    if (status === 'stopped') {
      console.log(`[PLATINUM] Sandbox ${externalId} is stopped, waking up...`);
      await this.start(externalId);
    }
  }
}
