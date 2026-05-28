/**
 * Platinum sandbox provider.
 *
 * Provisions sandboxes via the Platinum REST API
 * (https://api.platinum.dev) — Cloud Hypervisor microVMs on bare metal,
 * E2B-SDK-compatible shape. Kortix proxies sandbox traffic through the
 * HMAC-token URL returned by `POST /v1/sandboxes/:id/expose`.
 *
 * Unlike Daytona, Platinum has no per-project snapshot system in Kortix
 * today — every sandbox boots from a shared Platinum *template* (e.g.
 * `pt-base` or `kortix-computer`). The template name comes from
 * `opts.snapshot` if the caller set one, otherwise `config.PLATINUM_TEMPLATE`.
 */

import { config } from '../../config';
import { SANDBOX_VERSION } from '../../config';
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

interface PtSandbox {
  id: string;
  state: string;
  host_id?: string;
  warm?: boolean;
  // Present when the create body included `expose: [{port, ...}]` — saves the
  // dedicated POST /v1/sandboxes/:id/expose round-trip. Each entry is the
  // same shape POST /expose would have returned.
  exposed?: Array<{ port: number; url: string; token?: string; public: boolean }>;
}

interface PtSandboxState {
  id: string;
  state: string;
  internalIp: string | null;
  exposedPorts?: number[];
  hostId?: string | null;
}

interface PtExposeResult {
  url: string;
  port: number;
  sandbox_id: string;
  // HMAC-signed preview token, also embedded as `?t=<token>` in `url`.
  // Returned as a separate field so callers that need to attach it via
  // header (instead of query param) don't have to re-parse the URL.
  // Older Platinum CPs may omit this field; in that case the caller
  // should fall back to extracting `?t=` from `url`.
  token?: string;
}

/**
 * LLM provider keys + other high-entropy tokens the in-VM agent never reads
 * directly (it talks to KORTIX_LLM_BASE_URL for all model traffic). Project
 * secrets pass these through `runtimeSecrets` by default — dropped here so we
 * stay under Platinum's ~1KB kernel-cmdline env limit.
 */
const PLATINUM_DROP_KEYS = new Set<string>([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'XAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GROQ_API_KEY',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
]);

/** Map Platinum lifecycle states onto Kortix's tri-state. */
function mapStatus(state: string | undefined): SandboxStatus {
  const s = (state ?? '').toLowerCase();
  if (s === 'running' || s === 'starting' || s === 'resuming') return 'running';
  if (s === 'stopped' || s === 'stopping' || s === 'archived' || s === 'archiving') return 'stopped';
  if (s === 'deleted') return 'removed';
  return 'unknown';
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

  private get apiUrl(): string {
    const u = config.PLATINUM_API_URL;
    if (!u) throw new Error('Platinum provider requires PLATINUM_API_URL.');
    return u.replace(/\/+$/, '');
  }

  private get token(): string {
    const t = config.PLATINUM_API_KEY;
    if (!t) throw new Error('Platinum provider requires PLATINUM_API_KEY.');
    return t;
  }

  private async pt<T = unknown>(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.apiUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
      const text = await res.text();
      let parsed: unknown;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
      if (!res.ok) {
        throw new Error(`Platinum ${method} ${path} → ${res.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
      }
      return parsed as T;
    } finally {
      clearTimeout(t);
    }
  }

  async create(opts: CreateSandboxOpts): Promise<ProvisionResult> {
    // Two mutually-exclusive paths:
    //   1. `imageSpec` → send inline image to Platinum; CP hashes the spec,
    //      cache-hits a prior build or materializes a new template on-demand,
    //      then boots the sandbox in the same call. First boot pays the build
    //      cost (~5-60s alpine, ~minutes for big images); subsequent boots
    //      with the same spec are instant.
    //   2. `snapshot` / PLATINUM_TEMPLATE → reference a pre-built template
    //      (the legacy path; ~640ms warm-claim or ~2-3s cold cold-boot).
    const template = opts.imageSpec
      ? null
      : (opts.snapshot || config.PLATINUM_TEMPLATE || 'pt-base');

    const serviceKey = opts.envVars?.KORTIX_TOKEN || '';
    const apiBase = config.KORTIX_URL.replace(/\/v1\/router\/?$/, '');
    const routerBase = `${apiBase}/v1/router`;

    // Strip LLM provider keys from caller env. Platinum truncates env at ~1KB
    // (silently corrupts kernel cmdline → invm-agent never inits → 90s
    // "in-VM agent didn't respond" failed-start). The in-VM kortix-agent
    // routes all LLM calls through KORTIX_LLM_BASE_URL (Kortix's router proxy,
    // which already has the provider keys server-side), so forwarding them is
    // pure dead weight. Project secrets (listProjectSecrets) routinely include
    // ANTHROPIC_API_KEY / OPENROUTER_API_KEY which alone push us past 1KB.
    const filteredEnvVars = Object.fromEntries(
      Object.entries(opts.envVars ?? {}).filter(([k]) => !PLATINUM_DROP_KEYS.has(k)),
    );

    // Inline-image builds can take minutes for big bases — bump wait + RPC
    // timeout when imageSpec is in play. Pre-built templates stay on the fast
    // path (60s wait, 90s RPC).
    const waitMs = opts.imageSpec ? 600_000 : 60_000;
    const rpcMs  = opts.imageSpec ? 630_000 : 90_000;

    // Platinum holds the response open until state=running (or wait cap). One
    // RTT instead of a cross-Atlantic poll loop. If the create somehow returns
    // with a non-running state (timeout cap hit, or terminal failure), surface
    // that as an error so the caller doesn't keep going with a half-booted VM.
    const body: Record<string, unknown> = {
      env: {
        KORTIX_API_URL: apiBase,
        ENV_MODE: 'cloud',
        INTERNAL_SERVICE_KEY: serviceKey,
        TUNNEL_API_URL: apiBase,
        TUNNEL_TOKEN: serviceKey,
        TAVILY_API_URL: `${routerBase}/tavily`,
        REPLICATE_API_URL: `${routerBase}/replicate`,
        SERPER_API_URL: `${routerBase}/serper`,
        FIRECRAWL_API_URL: `${routerBase}/firecrawl`,
        ...filteredEnvVars,
      },
      auto_stop_minutes: 15,
      auto_archive_days: 7,
    };
    if (opts.imageSpec) body.image = opts.imageSpec;
    else body.template = template;
    // One-RTT spawn-with-expose: ask Platinum to bind the public route for
    // port 8000 in the same response as create. Falls back to the dedicated
    // POST /expose if the CP is an older build that drops the field.
    body.expose = [{ port: 8000 }];

    const created = await this.pt<PtSandbox>(
      'POST',
      `/v1/sandboxes?wait_for_state=running&wait_timeout_ms=${waitMs}`,
      body,
      rpcMs,
    );

    const externalId = created.id;
    if (created.state !== 'running') {
      throw new Error(`Platinum sandbox ${externalId} did not reach running (state=${created.state})`);
    }

    // Prefer the inline expose payload from the create response. Old CPs
    // that don't honour `expose` will omit the field — fall back to the
    // dedicated endpoint so existing prod stays working during the rollout.
    const inlineExposed = created.exposed?.find((e) => e.port === 8000);
    const exposed = inlineExposed
      ? { url: inlineExposed.url, port: 8000, sandbox_id: externalId }
      : await this.pt<PtExposeResult>('POST', `/v1/sandboxes/${externalId}/expose`, { port: 8000 });

    return {
      externalId,
      baseUrl: exposed.url.replace(/\/$/, ''),
      metadata: {
        provisionedBy: opts.userId,
        platinumSandboxId: externalId,
        platinumTemplate: template ?? `inline:${opts.imageSpec?.base_image}`,
        platinumExposedUrl: exposed.url,
        platinumHostId: created.host_id,
        warm: !!created.warm,
        version: SANDBOX_VERSION,
      },
    };
  }

  private async waitForRawState(externalId: string, terminal: ReadonlySet<string>, timeoutMs = 60_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
      const s = await this.pt<PtSandboxState>('GET', `/v1/sandboxes/${externalId}`);
      last = (s.state ?? '').toLowerCase();
      if (terminal.has(last)) return last;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Platinum sandbox ${externalId} did not reach ${[...terminal].join('|')} within ${timeoutMs}ms (last=${last})`);
  }

  async start(externalId: string): Promise<void> {
    // Stop may still be in flight (state='stopping'); Platinum returns 409
    // until it's fully stopped. Wait for a truly stoppable state first.
    const cur = await this.pt<PtSandboxState>('GET', `/v1/sandboxes/${externalId}`);
    if ((cur.state ?? '').toLowerCase() === 'stopping') {
      await this.waitForRawState(externalId, new Set(['stopped', 'archived']), 60_000);
    }
    await this.pt('POST', `/v1/sandboxes/${externalId}/start`, {});
    // Cold restore from a recently-archived sandbox can take a couple of
    // minutes — Platinum has to rehydrate the tar+zstd into rootfs.ext4.
    await this.waitForRawState(externalId, new Set(['running']), 180_000);
  }

  async stop(externalId: string): Promise<void> {
    await this.pt('POST', `/v1/sandboxes/${externalId}/stop`, {});
    await this.waitForRawState(externalId, new Set(['stopped', 'archived']), 120_000);
  }

  async remove(externalId: string): Promise<void> {
    await this.pt('DELETE', `/v1/sandboxes/${externalId}`);
  }

  async getStatus(externalId: string): Promise<SandboxStatus> {
    try {
      const s = await this.pt<PtSandboxState>('GET', `/v1/sandboxes/${externalId}`);
      return mapStatus(s.state);
    } catch {
      return 'unknown';
    }
  }

  async resolveEndpoint(externalId: string): Promise<ResolvedEndpoint> {
    // expose is idempotent — re-call so we always get a fresh HMAC-signed
    // URL even after a stop/start may have moved the sandbox to a new host.
    const exposed = await this.pt<PtExposeResult>('POST', `/v1/sandboxes/${externalId}/expose`, { port: 8000 });

    // Platinum returns `https://<short>.sbx.platinum.dev/?t=<token>`. The
    // trailing `?t=...` query is the HMAC signature edge proxy verifies
    // before forwarding. If we leave it in `url` and the caller appends a
    // path (e.g. preview.ts:syncProjectEnvToSandbox doing
    // `url + '/kortix/env'`), the path lands AFTER the query, producing
    // `?t=<token>/kortix/env` — the slashed token then fails HMAC verify
    // with `404 bad-token`. Strip the query here so the bare base URL is
    // safe to append paths to, and surface the token via the dedicated
    // `token` field so downstream code attaches it as a header (the
    // platinum edge accepts both query and header forms equally).
    //
    // Back-compat: if a newer CP omits the separate `token` field, fall
    // back to extracting from the URL's `t` query parameter. If both are
    // empty (public exposure), `token` stays null.
    const parsed = new URL(exposed.url);
    const cleanUrl = `${parsed.origin}${parsed.pathname}`.replace(/\/$/, '');
    const token = exposed.token ?? parsed.searchParams.get('t') ?? null;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    // Attach the preview token by default so callers that just use
    // `{url, headers}` (without consulting `token`) still authenticate
    // correctly against platinum's edge. Callers that prefer the query-
    // string form can read `token` and re-build the URL themselves.
    if (token) headers['X-Daytona-Preview-Token'] = token;

    // Look up the per-sandbox service key from the sessionSandboxes row so
    // Kortix can authenticate to the in-VM supervisor (same pattern as
    // DaytonaProvider.resolveEndpoint).
    try {
      const { eq } = await import('drizzle-orm');
      const { sandboxes } = await import('@kortix/db');
      const { db } = await import('../../shared/db');
      const [row] = await db
        .select({ config: sandboxes.config })
        .from(sandboxes)
        .where(eq(sandboxes.externalId, externalId))
        .limit(1);
      const serviceKey = (row?.config as Record<string, unknown> | null)?.serviceKey as string | undefined;
      if (serviceKey) headers['Authorization'] = `Bearer ${serviceKey}`;
    } catch (err) {
      console.warn(`[PLATINUM] Failed to look up service key for ${externalId}:`, err);
    }

    return { url: cleanUrl, headers, token };
  }

  async ensureRunning(externalId: string): Promise<void> {
    const status = await this.getStatus(externalId);
    if (status === 'running') return;
    console.log(`[PLATINUM] Sandbox ${externalId} is ${status}, waking up...`);
    await this.start(externalId);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const s = await this.getStatus(externalId);
      if (s === 'running') return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Platinum sandbox ${externalId} did not reach running within 30s`);
  }
}
