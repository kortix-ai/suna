import { eq } from 'drizzle-orm';
import { sandboxes } from '@kortix/db';
import { db } from '../../shared/db';
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

const KORTIX_MASTER_PORT = 8000;
const API_TIMEOUT_MS = 300_000;
const PROVISION_TIMEOUT_MS = 600_000;
const POLL_INTERVAL_MS = 3_000;

interface JustAVPSMachine {
  id: string;
  slug: string;
  name: string;
  status: string;
  provisioning_stage: string | null;
  provisioning_stage_updated_at: string | null;
  provider: string;
  image_id: string | null;
  server_type: string;
  region: string;
  ip: string | null;
  price_monthly: number | null;
  backups_enabled: boolean;
  source: string;
  kortix_sandbox_id: string | null;
  created_at: string;
  ready_at: string | null;
  urls: { vscode: string; pty: string; port_template: string } | null;
  ssh: string | null;
  ssh_key: {
    private_key: string | null;
    public_key: string | null;
    setup_command: string | null;
    key_path: string;
  } | null;
  connect: {
    ssh_command: string | null;
    setup_command: string | null;
    vscode_url: string;
    cursor_ssh: string | null;
  } | null;
  health: {
    cpu: number;
    memory: number;
    disk: number;
    services: Record<string, boolean>;
    last_heartbeat_at: string | null;
  } | null;
}

interface JustAVPSServerType {
  name: string;
  description: string;
  vcpu: number;
  ram_gb: number;
  disk_gb: number;
  cpu_type: string;
  architecture: string;
  price_monthly: number;
  provider_price_monthly: number;
  backup_price_monthly: number;
  available: boolean;
}

export interface JustAVPSBackup {
  id: string;
  description: string;
  created: string;
  size: number;
  status: string;
}

interface JustAVPSWebhook {
  id: string;
  url: string;
  events: string[];
  secret: string;
  active: boolean;
  created_at: string;
}

export async function justavpsFetch<T = any>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const baseUrl = config.JUSTAVPS_API_URL.replace(/\/$/, '');
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${config.JUSTAVPS_API_KEY}`,
  };
  if (options.body) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`JustAVPS API ${options.method || 'GET'} ${path} returned ${res.status}: ${text.slice(0, 300)}`);
  }

  if (res.status === 204) return {} as T;
  return res.json() as Promise<T>;
}


export const PROXY_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
export const PROXY_TOKEN_REFRESH_BUFFER_MS = 24 * 60 * 60 * 1000;

export interface ProxyTokenRecord {
  token: string;
  id: string;
  expiresAt: number; // ms epoch
}

interface JustAvpsProxyTokenResponse {
  id: string;
  token: string;
  expires_at: string;
}

const inflightRefreshes = new Map<string, Promise<ProxyTokenRecord | null>>();

export function isProxyTokenStale(meta: Record<string, unknown> | undefined | null): boolean {
  if (!meta) return true;
  const token = meta.justavpsProxyToken;
  if (typeof token !== 'string' || token.length === 0) return true;
  const expiresAt = meta.justavpsProxyTokenExpiresAt;
  if (typeof expiresAt !== 'number') return true;
  return Date.now() > expiresAt - PROXY_TOKEN_REFRESH_BUFFER_MS;
}

export async function mintProxyTokenOnJustAvps(
  externalId: string,
): Promise<ProxyTokenRecord | null> {
  try {
    const res = await justavpsFetch<JustAvpsProxyTokenResponse>('/proxy-tokens', {
      method: 'POST',
      body: {
        machine_id: externalId,
        label: `kortix-sandbox-${externalId}`,
        expires_in_seconds: PROXY_TOKEN_TTL_SECONDS,
      },
    });
    return {
      token: res.token,
      id: res.id,
      expiresAt: new Date(res.expires_at).getTime(),
    };
  } catch (err) {
    console.warn(`[JUSTAVPS] Failed to mint proxy token for ${externalId}:`, err);
    return null;
  }
}

export async function refreshSandboxProxyToken(
  externalId: string,
  currentMeta: Record<string, unknown>,
): Promise<ProxyTokenRecord | null> {
  const existing = inflightRefreshes.get(externalId);
  if (existing) return existing;

  const promise = (async (): Promise<ProxyTokenRecord | null> => {
    const minted = await mintProxyTokenOnJustAvps(externalId);
    if (!minted) return null;

    const oldTokenId = typeof currentMeta.justavpsProxyTokenId === 'string'
      ? currentMeta.justavpsProxyTokenId
      : undefined;

    try {
      await db.update(sandboxes).set({
        metadata: {
          ...currentMeta,
          justavpsProxyToken: minted.token,
          justavpsProxyTokenId: minted.id,
          justavpsProxyTokenExpiresAt: minted.expiresAt,
        },
        updatedAt: new Date(),
      }).where(eq(sandboxes.externalId, externalId));
      console.log(
        `[JUSTAVPS] Refreshed proxy token for ${externalId} (new expiry ${new Date(minted.expiresAt).toISOString()})`,
      );
    } catch (err) {
      console.error(`[JUSTAVPS] Failed to persist refreshed proxy token for ${externalId}:`, err);
    }

    if (oldTokenId) {
      justavpsFetch(`/proxy-tokens/${oldTokenId}`, { method: 'DELETE' })
        .catch((err) => console.warn(`[JUSTAVPS] Failed to revoke old proxy token ${oldTokenId}:`, err));
    }

    return minted;
  })();

  inflightRefreshes.set(externalId, promise);
  try {
    return await promise;
  } finally {
    inflightRefreshes.delete(externalId);
  }
}

interface JustAVPSImage {
  id: string;
  name: string;
  status: string;
  created_at: string;
}

let cachedImageId: string | null = null;
let cachedImageExpiry = 0;
const IMAGE_CACHE_TTL_MS = 5 * 60 * 1000;
const IMAGE_NAME_PREFIX = 'kortix-computer-v';
const DEV_IMAGE_NAME_PREFIX = 'kortix-computer-vdev-';

function parseSemver(version: string): number[] {
  return version.split('.').map(Number).filter((n) => !isNaN(n));
}

function compareSemver(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

async function resolveLatestImageId(): Promise<string | null> {
  if (config.JUSTAVPS_IMAGE_ID) {
    return config.JUSTAVPS_IMAGE_ID;
  }

  if (cachedImageId && Date.now() < cachedImageExpiry) {
    return cachedImageId;
  }

  try {
    const data = await justavpsFetch<{ images: JustAVPSImage[] }>('/images');
    const readyImages = (data.images || []).filter((img) => img.status === 'ready');

    const devCandidates = readyImages
      .filter((img) => img.name.startsWith(DEV_IMAGE_NAME_PREFIX))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    if (devCandidates.length > 0) {
      cachedImageId = devCandidates[0].id;
      cachedImageExpiry = Date.now() + IMAGE_CACHE_TTL_MS;
      console.log(`[JUSTAVPS] Auto-resolved dev image: ${devCandidates[0].name} → ${cachedImageId}`);
      return cachedImageId;
    }

    const semverCandidates = readyImages
      .filter((img) => img.name.startsWith(IMAGE_NAME_PREFIX) && !img.name.startsWith(DEV_IMAGE_NAME_PREFIX))
      .map((img) => ({
        id: img.id,
        version: parseSemver(img.name.slice(IMAGE_NAME_PREFIX.length)),
        name: img.name,
      }))
      .sort((a, b) => compareSemver(b.version, a.version));

    if (semverCandidates.length > 0) {
      cachedImageId = semverCandidates[0].id;
      cachedImageExpiry = Date.now() + IMAGE_CACHE_TTL_MS;
      console.log(`[JUSTAVPS] Auto-resolved image: ${semverCandidates[0].name} → ${cachedImageId}`);
      return cachedImageId;
    }

    console.warn('[JUSTAVPS] No images matching kortix-computer-v* found; provisioning without image_id');
    return null;
  } catch (err) {
    console.warn('[JUSTAVPS] Failed to resolve latest image, falling back to no image_id:', err);
    return null;
  }
}

export function invalidateImageCache(): void {
  cachedImageId = null;
  cachedImageExpiry = 0;
}

export interface ServerTypeWithPricing {
  name: string;
  description: string;
  cores: number;
  memory: number;
  disk: number;
  cpuType: string;
  architecture: string;
  priceMonthly: number;
  priceMonthlyMarkup: number;
  providerPriceMonthly: number;
  location: string;
}

export async function listServerTypes(
  location?: string,
): Promise<ServerTypeWithPricing[]> {
  const loc = location || config.JUSTAVPS_DEFAULT_LOCATION;
  const data = await justavpsFetch<{ server_types: JustAVPSServerType[] }>(
    `/server-types?provider=cloud&region=${loc}`,
  );

  return data.server_types
    .filter((st) => st.available)
    .map((st) => ({
      name: st.name,
      description: st.description,
      cores: st.vcpu,
      memory: st.ram_gb,
      disk: st.disk_gb,
      cpuType: st.cpu_type,
      architecture: st.architecture,
      priceMonthly: st.price_monthly,
      priceMonthlyMarkup: st.price_monthly,
      providerPriceMonthly: st.provider_price_monthly,
      location: loc,
    }))
    .sort((a, b) => a.priceMonthly - b.priceMonthly);
}

let webhookRegistered = false;

async function ensureWebhookRegistered(): Promise<void> {
  if (webhookRegistered) return;

  const webhookUrl = config.JUSTAVPS_WEBHOOK_URL;
  const webhookSecret = config.JUSTAVPS_WEBHOOK_SECRET;
  if (!webhookUrl) {
    console.warn('[JUSTAVPS] JUSTAVPS_WEBHOOK_URL not configured — provisioning events will not flow back to Kortix');
    webhookRegistered = true;
    return;
  }

  try {
    const existing = await justavpsFetch<{ webhooks: JustAVPSWebhook[] }>('/webhooks');
    const alreadyRegistered = existing.webhooks?.some((w) => w.url === webhookUrl);

    if (alreadyRegistered) {
      console.log('[JUSTAVPS] Webhook already registered');
      webhookRegistered = true;
      return;
    }

    await justavpsFetch<JustAVPSWebhook>('/webhooks', {
      method: 'POST',
      body: {
        url: webhookUrl,
        events: ['*'],
        secret: webhookSecret || undefined,
      },
    });

    console.log(`[JUSTAVPS] Webhook registered → ${webhookUrl}`);
    webhookRegistered = true;
  } catch (err) {
    console.error('[JUSTAVPS] Failed to register webhook:', err);
  }
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function resolveReachableKortixApiUrl(): string {
  const directBase = config.KORTIX_URL.replace(/\/v1\/router\/?$/, '');

  try {
    const parsed = new URL(directBase);
    const localHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0']);
    const isLocalOnly = localHosts.has(parsed.hostname) || parsed.hostname.endsWith('.local');

    if (isLocalOnly && config.JUSTAVPS_WEBHOOK_URL) {
      return new URL(config.JUSTAVPS_WEBHOOK_URL).origin;
    }
  } catch {
  }

  return directBase;
}


export function buildCustomerCloudInitScript(dockerImage: string): string {
  return [
    'curl -fsSL https://raw.githubusercontent.com/kortix-ai/suna/main/scripts/start-sandbox.sh -o /usr/local/bin/kortix-start-sandbox.sh',
    'chmod +x /usr/local/bin/kortix-start-sandbox.sh',
    `/usr/local/bin/kortix-start-sandbox.sh ${shellEscape(dockerImage)}`,
  ].join('\n');
}

export class JustAVPSProvider implements SandboxProvider {
  readonly name: ProviderName = 'justavps';

  readonly provisioning: ProvisioningTraits = {
    async: true,
    stages: [
      { id: 'server_creating', progress: 10, message: 'Creating server...' },
      { id: 'server_created', progress: 20, message: 'Server created, running cloud-init...' },
      { id: 'cloud_init_running', progress: 35, message: 'Configuring machine...' },
      { id: 'cloud_init_done', progress: 50, message: 'Configuration complete...' },
      { id: 'docker_pulling', progress: 60, message: 'Starting sandbox container...' },
      { id: 'docker_running', progress: 75, message: 'Container started, booting services...' },
      { id: 'services_starting', progress: 85, message: 'Services booting...' },
      { id: 'services_ready', progress: 100, message: 'Ready' },
    ],
  };

  async getProvisioningStatus(sandboxId: string): Promise<ProvisioningStatus | null> {
    const [row] = await db
      .select({ metadata: sandboxes.metadata, status: sandboxes.status, externalId: sandboxes.externalId })
      .from(sandboxes)
      .where(eq(sandboxes.sandboxId, sandboxId))
      .limit(1);

    if (!row) return null;

    const meta = (row.metadata as Record<string, unknown>) ?? {};

    if (row.status === 'active') {
      return { stage: 'services_ready', progress: 100, message: 'Ready', complete: true, error: false };
    }

    if (row.status === 'error') {
      return {
        stage: 'error',
        progress: 0,
        message: (meta.provisioningError as string) || (meta.provisioningMessage as string) || 'Provisioning failed',
        complete: false,
        error: true,
        errorMessage: (meta.provisioningError as string) || undefined,
      };
    }

    // Read provisioning stage from local DB (updated by webhooks).
    // Don't poll JustAVPS directly — webhooks are the source of truth for stage progression.
    const stage = (meta.provisioningStage as string) || 'server_creating';
    const stageInfo = this.provisioning.stages.find((s) => s.id === stage);

    return {
      stage,
      progress: stageInfo?.progress ?? 10,
      message: (meta.provisioningMessage as string) || stageInfo?.message || 'Provisioning...',
      complete: false,
      error: false,
    };
  }

  async create(opts: CreateSandboxOpts): Promise<ProvisionResult> {
    await ensureWebhookRegistered();

    const serverType = opts.serverType || config.JUSTAVPS_DEFAULT_SERVER_TYPE;
    const location = opts.location || config.JUSTAVPS_DEFAULT_LOCATION;
    const sandboxApiBase = resolveReachableKortixApiUrl().replace(/\/v1\/router\/?$/, '');
    const routerBase = `${sandboxApiBase}/v1/router`;

    const serviceKey = opts.envVars?.KORTIX_TOKEN || '';
    // Inject the API's own version into the sandbox container so the sandbox
    // health endpoint reports the correct version. All components share one
    // version number (set by deploy-zero-downtime.sh from the Docker image tag).
    // This works even when SANDBOX_IMAGE defaults to :latest.
    const envVars: Record<string, string> = {
      KORTIX_API_URL: sandboxApiBase,
      ENV_MODE: 'cloud',
      INTERNAL_SERVICE_KEY: serviceKey,
      KORTIX_TOKEN: serviceKey,
      SANDBOX_VERSION: SANDBOX_VERSION,
      KORTIX_SANDBOX_VERSION: SANDBOX_VERSION,
      TUNNEL_API_URL: sandboxApiBase,
      TUNNEL_TOKEN: serviceKey,
      TAVILY_API_URL: `${routerBase}/tavily`,
      REPLICATE_API_URL: `${routerBase}/replicate`,
      SERPER_API_URL: `${routerBase}/serper`,
      FIRECRAWL_API_URL: `${routerBase}/firecrawl`,
      // Only inject CRW proxy URL when backend has CRW key configured
      ...(config.CRW_API_KEY ? { CRW_API_URL: `${routerBase}/crw` } : {}),
      PUID: '911',
      PGID: '911',
      ...opts.envVars,
    };

    const body: Record<string, unknown> = {
      provider: 'cloud',
      server_type: serverType,
      region: location,
      name: `kortix-sandbox-${opts.accountId.slice(0, 8)}-${Date.now().toString(36)}`,
      env_vars: envVars,
      cloud_init_script: buildCustomerCloudInitScript(config.SANDBOX_IMAGE),
      enable_backups: true,
    };

    const imageId = await resolveLatestImageId();
    if (imageId) {
      body.image_id = imageId;
    }

    const machine = await justavpsFetch<JustAVPSMachine>('/machines', {
      method: 'POST',
      body,
    });

    console.log(`[JUSTAVPS] Machine creation started: ${machine.id} (slug: ${machine.slug})`);

    const proxyDomain = config.JUSTAVPS_PROXY_DOMAIN;
    const cfBaseUrl = `https://${machine.slug}.${proxyDomain}`;

    // Mint an initial proxy token for CF Worker auth. Lifetime is capped by
    // JustAVPS (currently 7 days) — refreshSandboxProxyToken() handles rotation
    // on subsequent requests before the token actually expires.
    const minted = await mintProxyTokenOnJustAvps(machine.id);
    if (minted) {
      console.log(`[JUSTAVPS] Proxy token created for machine ${machine.id}`);
    } else {
      console.warn(`[JUSTAVPS] Proxy token mint failed for ${machine.id}, will retry lazily on first request`);
    }

    return {
      externalId: machine.id,
      baseUrl: cfBaseUrl,
      metadata: {
        justavpsMachineId: machine.id,
        justavpsSlug: machine.slug,
        justavpsProxyToken: minted?.token,
        justavpsProxyTokenId: minted?.id,
        justavpsProxyTokenExpiresAt: minted?.expiresAt,
        provisioningStage: 'server_creating',
        serverType,
        location,
        version: SANDBOX_VERSION,
      },
    };
  }

  async start(externalId: string): Promise<void> {
    await justavpsFetch(`/machines/${externalId}/start`, { method: 'POST' });
    console.log(`[JUSTAVPS] Started machine ${externalId}`);
  }

  async stop(externalId: string): Promise<void> {
    await justavpsFetch(`/machines/${externalId}/stop`, { method: 'POST' });
    console.log(`[JUSTAVPS] Stopped machine ${externalId}`);
  }

  async remove(externalId: string): Promise<void> {
    await justavpsFetch(`/machines/${externalId}`, { method: 'DELETE' });
    console.log(`[JUSTAVPS] Deleted machine ${externalId}`);
  }

  async getStatus(externalId: string): Promise<SandboxStatus> {
    try {
      const machine = await justavpsFetch<JustAVPSMachine>(`/machines/${externalId}`);
      const status = machine.status;
      if (status === 'ready') return 'running';
      if (status === 'stopped') return 'stopped';
      if (status === 'deleted') return 'removed';
      if (status === 'provisioning') return 'unknown';
      if (status === 'error') return 'stopped';
      return 'unknown';
    } catch (err: any) {
      if (err.message?.includes('404')) return 'removed';
      return 'unknown';
    }
  }

  async resolveEndpoint(externalId: string): Promise<ResolvedEndpoint> {
    const [row] = await db
      .select({ baseUrl: sandboxes.baseUrl, config: sandboxes.config, metadata: sandboxes.metadata })
      .from(sandboxes)
      .where(eq(sandboxes.externalId, externalId))
      .limit(1);

    const meta = (row?.metadata as Record<string, unknown>) ?? {};
    const slug = meta.justavpsSlug as string | undefined;
    const proxyDomain = config.JUSTAVPS_PROXY_DOMAIN;

    let url = row?.baseUrl;

    // Migrate old API proxy URLs to CF proxy URLs
    if (!url || url === '' || url.includes('/machines/') || url.startsWith('http://')) {
      if (slug) {
        url = `https://${slug}.${proxyDomain}`;
      } else {
        // Fallback: fetch slug from JustAVPS API
        const machine = await justavpsFetch<JustAVPSMachine>(`/machines/${externalId}`);
        url = `https://${machine.slug}.${proxyDomain}`;
      }

      if (row) {
        await db.update(sandboxes).set({ baseUrl: url, updatedAt: new Date() })
          .where(eq(sandboxes.externalId, externalId));
      }
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Proxy token for CF Worker auth (doesn't consume the Authorization header).
    // Proactively refresh when missing, legacy (no expiresAt), or within the
    // refresh buffer of expiry. refreshSandboxProxyToken dedups concurrent
    // refreshes for the same sandbox in-process.
    let proxyToken = meta.justavpsProxyToken as string | undefined;
    if (row && isProxyTokenStale(meta)) {
      const refreshed = await refreshSandboxProxyToken(externalId, meta);
      if (refreshed) {
        proxyToken = refreshed.token;
      }
    }

    if (proxyToken) {
      headers['X-Proxy-Token'] = proxyToken;
    }

    // Service key for core/kortix-master auth
    const serviceKey = (row?.config as Record<string, unknown>)?.serviceKey as string | undefined;
    if (serviceKey) {
      headers['Authorization'] = `Bearer ${serviceKey}`;
    } else if (config.INTERNAL_SERVICE_KEY) {
      headers['Authorization'] = `Bearer ${config.INTERNAL_SERVICE_KEY}`;
    }

    return { url, headers };
  }

  async ensureRunning(externalId: string): Promise<void> {
    try {
      const machine = await justavpsFetch<JustAVPSMachine>(`/machines/${externalId}`);
      if (machine.status === 'ready') return;
      if (machine.status === 'provisioning') {
        console.log(`[JUSTAVPS] Machine ${externalId} still provisioning, waiting...`);
        await this.waitForStatus(externalId, 'ready');
        return;
      }
      if (machine.status === 'error' || machine.status === 'deleted') {
        throw new Error(`[JUSTAVPS] Machine ${externalId} is in '${machine.status}' state`);
      }
      console.log(`[JUSTAVPS] Machine ${externalId} is '${machine.status}', rebooting...`);
      await this.start(externalId);
      await this.waitForStatus(externalId, 'ready');
    } catch (err: any) {
      if (err.message?.includes('404')) {
        throw new Error(`[JUSTAVPS] Machine ${externalId} not found`);
      }
      throw err;
    }
  }

  // ─── Backups ──────────────────────────────────────────────────────────────

  async listBackups(externalId: string): Promise<{ backups: JustAVPSBackup[]; backups_enabled: boolean }> {
    return justavpsFetch<{ backups: JustAVPSBackup[]; backups_enabled: boolean }>(
      `/machines/${externalId}/backups`,
    );
  }

  async createBackup(externalId: string, description?: string): Promise<{ backup_id: string; status: string }> {
    return justavpsFetch<{ backup_id: string; status: string }>(
      `/machines/${externalId}/backups`,
      { method: 'POST', body: description ? { description } : undefined },
    );
  }

  async restoreBackup(externalId: string, backupId: string): Promise<void> {
    await justavpsFetch(`/machines/${externalId}/backups/${backupId}/restore`, { method: 'POST' });
  }

  async deleteBackup(externalId: string, backupId: string): Promise<void> {
    await justavpsFetch(`/machines/${externalId}/backups/${backupId}`, { method: 'DELETE' });
  }

  private async waitForIp(
    machineId: string,
    timeoutMs = PROVISION_TIMEOUT_MS,
  ): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const machine = await justavpsFetch<JustAVPSMachine>(`/machines/${machineId}`);
      if (machine.ip) return machine.ip;
      if (machine.status === 'error' || machine.status === 'deleted') {
        throw new Error(`[JUSTAVPS] Machine ${machineId} entered '${machine.status}' while waiting for IP`);
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error(`[JUSTAVPS] Machine ${machineId} did not get an IP within ${timeoutMs / 1000}s`);
  }

  private async waitForStatus(
    machineId: string,
    target: string,
    timeoutMs = PROVISION_TIMEOUT_MS,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const machine = await justavpsFetch<JustAVPSMachine>(`/machines/${machineId}`);
      if (machine.status === target) return;
      if (machine.status === 'error' || machine.status === 'deleted') {
        throw new Error(`[JUSTAVPS] Machine ${machineId} entered '${machine.status}' state while waiting for '${target}'`);
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error(`[JUSTAVPS] Machine ${machineId} did not reach '${target}' within ${timeoutMs / 1000}s`);
  }
}
