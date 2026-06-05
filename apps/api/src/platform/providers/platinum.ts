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
      ...opts.envVars,
    };
    if (!envVars.KORTIX_TOKEN) {
      throw new Error('[platinum] create() called without KORTIX_TOKEN — sandbox cannot authenticate to the Kortix router.');
    }

    // autoStopInterval maps to Platinum's auto_stop_minutes. 0 (warm-pool) →
    // persistent (never auto-stops); >0 → ephemeral with that idle timeout.
    const autoStop = opts.autoStopInterval ?? 15;

    const _t0 = Date.now();
    const sandbox = await platinumJson<PlatinumSandbox>(
      '/v1/sandboxes?wait_for_state=running&wait_timeout_ms=60000',
      {
        method: 'POST',
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

    // Wait for the in-guest runtime to actually be READY before returning. A
    // warm claim is instant (~0.1s) but the daemon then materializes the repo
    // (git clone) + confirms opencode; until runtimeReady the proxy 503s. If we
    // return at 'running' (VM up), the FE immediately hits /session, /command,
    // /global/events, prompt_async — all 503 "opencode not ready" — and the
    // session-chat gives up after 3 retries. Daytona's create returns a usable
    // box; this gives parity: the session only goes live once the sandbox serves.
    // Repo clone is usually ~2s but can transiently stall, so poll up to 75s.
    // Best-effort: on timeout we return anyway and the FE's retries cover the tail.
    const _tReady0 = Date.now();
    let _polls = 0; let _firstHttpMs = 0; let _lastHealth: unknown = null;
    if (exposedUrl) {
      const token = envVars.KORTIX_TOKEN;
      const deadline = Date.now() + 75_000;
      let ready = false;
      while (Date.now() < deadline) {
        _polls++;
        try {
          const r = await fetch(`${exposedUrl}/kortix/health`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            signal: AbortSignal.timeout(6000),
          });
          if (!_firstHttpMs && r.status) _firstHttpMs = Date.now() - _tReady0; // first time the edge answered at all
          if (r.ok) {
            const h = (await r.json().catch(() => ({}))) as { runtimeReady?: boolean };
            _lastHealth = h;
            if (h?.runtimeReady === true) { ready = true; break; }
          }
        } catch { /* keep polling through transient edge/clone hiccups */ }
        await new Promise((res) => setTimeout(res, 1000));
      }
      if (!ready) console.warn(`[platinum] ${externalId} not runtimeReady within 75s — returning anyway (FE will retry)`);
      const _readyMs = Date.now() - _tReady0;
      console.log(
        `[platinum-timing] ${externalId} vm-running=${_vmMs}ms expose=${_exposeMs}ms ` +
        `runtime-ready=${_readyMs}ms (polls=${_polls}, edge-first-answer=${_firstHttpMs}ms) ` +
        `total=${Date.now() - _t0}ms health=${JSON.stringify(_lastHealth)}`,
      );
    }

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
    } catch {
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
