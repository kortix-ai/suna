import Docker from 'dockerode';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { config, SANDBOX_VERSION } from '../../config';
import { generateSandboxKeyPair } from '../../shared/crypto';
import { getAuthCandidates, getSandboxServiceKeyByExternalId } from '../services/sandbox-auth';
import { isForbiddenSandboxEnv } from '../sandbox-env';
import type {
  SandboxProvider,
  ProviderName,
  CreateSandboxOpts,
  ProvisionResult,
  SandboxStatus,
  ResolvedEndpoint,
  ProvisioningTraits,
  ProvisioningStatus,
} from './types';

/** Container name — configurable so self-hosted and dev can coexist. */
const CONTAINER_NAME = config.SANDBOX_CONTAINER_NAME;

const PORT_BASE = config.SANDBOX_PORT_BASE;

const PORT_MAP: Record<string, string> = {
  '8000': String(PORT_BASE + 0),
  '3111': String(PORT_BASE + 1),
  '6080': String(PORT_BASE + 2),
  '6081': String(PORT_BASE + 3),
  '3210': String(PORT_BASE + 4),
  '9223': String(PORT_BASE + 5),
  '9224': String(PORT_BASE + 6),
  '22':   String(PORT_BASE + 7),
};

const BASE_URL = `http://localhost:${PORT_MAP['8000']}`;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `"'"'`)}'`;
}

function buildDockerEnvWriteCommand(payload: Record<string, string>, targetDir: string): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return `mkdir -p ${targetDir} && ENV_WRITE_PAYLOAD_B64=${shellQuote(payloadB64)} python3 - <<PY
import base64, json, os
from pathlib import Path

target_dir = Path(${JSON.stringify(targetDir)})
target_dir.mkdir(parents=True, exist_ok=True)
payload = json.loads(base64.b64decode(os.environ["ENV_WRITE_PAYLOAD_B64"]).decode("utf-8"))
for key, value in payload.items():
    (target_dir / key).write_text(value)
PY`;
}

const EXPOSED_PORTS: Record<string, {}> = Object.fromEntries(
  Object.keys(PORT_MAP).map((p) => [`${p}/tcp`, {}]),
);

const PORT_BINDINGS: Record<string, { HostPort: string; HostIp: string }[]> = Object.fromEntries(
  Object.entries(PORT_MAP).map(([container, host]) => [
    `${container}/tcp`,
    [{ HostPort: host, HostIp: '127.0.0.1' }],
  ]),
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Compute the URL the sandbox container should use to reach kortix-api.
 *
 * This is the INTERNAL url — how the sandbox talks to kortix-api from inside Docker.
 * NOT the external/browser-facing URL.
 *
 * - Shared Docker network (SANDBOX_NETWORK set):  http://kortix-api:{PORT}  (Docker DNS)
 * - Default bridge (sandbox on host ports):        http://host.docker.internal:{PORT}
 *
 * If KORTIX_URL is set to something other than localhost (e.g. a real domain),
 * we use it as-is since the sandbox can reach it directly.
 */
function getSandboxInternalApiUrl(): string {
  if (config.SANDBOX_NETWORK) {
    return `http://kortix-api:${config.PORT}`;
  }

  const externalUrl = config.KORTIX_URL?.replace(/\/v1\/router\/?$/, '');
  if (externalUrl) {
    try {
      const parsed = new URL(externalUrl);
      if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
        parsed.hostname = 'host.docker.internal';
        return parsed.toString().replace(/\/$/, '');
      }
      return externalUrl.replace(/\/$/, '');
    } catch {
    }
  }

  return `http://host.docker.internal:${config.PORT}`;
}

/**
 * Read key=value pairs from the core/docker/.env file.
 * API keys and credentials that OpenCode needs inside the container.
 */
function readSandboxEnv(): string[] {
  const candidates = [
    resolve(__dirname, '../../../../../core/docker/.env'),
    resolve(process.cwd(), 'core/docker/.env'),
    resolve(process.cwd(), '../../core/docker/.env'),
  ];
  for (const envPath of candidates) {
    try {
      const content = readFileSync(envPath, 'utf-8');
      return content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#') && line.includes('='));
    } catch {
      continue;
    }
  }
  return [];
}

function getDocker(): Docker {
  if (config.DOCKER_HOST) {
    if (config.DOCKER_HOST.startsWith('tcp://') || config.DOCKER_HOST.startsWith('http://')) {
      const url = new URL(config.DOCKER_HOST);
      return new Docker({ host: url.hostname, port: parseInt(url.port || '2375') });
    }
    const socketPath = config.DOCKER_HOST.replace(/^unix:\/\//, '');
    return new Docker({ socketPath });
  }
  return new Docker();
}

interface ImagePullStatus {
  state: 'idle' | 'pulling' | 'done' | 'error';
  progress: number;
  message: string;
  error?: string;
}

let _pullStatus: ImagePullStatus = { state: 'idle', progress: 0, message: '' };

function getImagePullStatus(): ImagePullStatus {
  return { ..._pullStatus };
}

export class LocalDockerProvider implements SandboxProvider {
  readonly name: ProviderName = 'local_docker';
  private docker: Docker;
  private _serviceKeySynced = false;

  readonly provisioning: ProvisioningTraits = {
    async: true,
    stages: [
      { id: 'pulling', progress: 20, message: 'Pulling sandbox image...' },
      { id: 'creating', progress: 70, message: 'Creating container...' },
      { id: 'starting', progress: 85, message: 'Starting services...' },
      { id: 'ready', progress: 100, message: 'Ready' },
    ],
  };

  async getProvisioningStatus(_sandboxId: string): Promise<ProvisioningStatus | null> {
    const pullStatus = getImagePullStatus();

    if (pullStatus.state === 'pulling') {
      return {
        stage: 'pulling',
        progress: Math.max(5, Math.round(pullStatus.progress * 0.6)),
        message: pullStatus.message || 'Pulling sandbox image...',
        complete: false,
        error: false,
      };
    }

    if (pullStatus.state === 'error') {
      return {
        stage: 'error',
        progress: 0,
        message: pullStatus.message,
        complete: false,
        error: true,
        errorMessage: pullStatus.error,
      };
    }

    const existing = await this.find();
    if (existing && existing.status === 'running') {
      return {
        stage: 'ready',
        progress: 100,
        message: 'Ready',
        complete: true,
        error: false,
      };
    }

    if (pullStatus.state === 'done') {
      return {
        stage: 'creating',
        progress: 70,
        message: 'Creating container...',
        complete: false,
        error: false,
      };
    }

    return {
      stage: 'idle',
      progress: 0,
      message: 'Waiting to start...',
      complete: false,
      error: false,
    };
  }

  constructor() {
    this.docker = getDocker();
  }

  async ensure(): Promise<SandboxInfo> {
    const existing = await this.find();

    if (existing) {
      if (existing.status === 'running') {
        await this.syncCoreEnvVars();
        const callerToken = this._lastCreateOpts?.envVars?.KORTIX_TOKEN;
        if (callerToken) {
          await this.syncTokenToContainer(callerToken);
        }
        return existing;
      }
      const container = this.docker.getContainer(existing.containerId);
      try {
        await container.start();
      } catch (err: any) {
        const message = err?.message || String(err);
        if (!message.includes('marked for removal')) throw err;
        console.warn('[LOCAL-DOCKER] Existing sandbox container is marked for removal, recreating...');
        try {
          await container.remove({ force: true, v: false });
        } catch {
          // Ignore and continue to recreate
        }
        await this.createContainer();
        return this.getSandboxInfo();
      }
      await this.syncCoreEnvVars();
      return this.getSandboxInfo();
    }

    await this.createContainer();
    return this.getSandboxInfo();
  }

  async find(): Promise<SandboxInfo | null> {
    try {
      const container = this.docker.getContainer(CONTAINER_NAME);
      const info = await container.inspect();
      return this.toSandboxInfo(info);
    } catch (err: any) {
      if (err?.statusCode === 404) return null;
      throw err;
    }
  }

  async getSandboxInfo(): Promise<SandboxInfo> {
    const info = await this.find();
    if (!info) throw new Error('Sandbox container not found');
    return info;
  }

  async start(): Promise<void> {
    const container = this.docker.getContainer(CONTAINER_NAME);
    await container.start();
  }

  async stop(): Promise<void> {
    const container = this.docker.getContainer(CONTAINER_NAME);
    await container.stop({ t: 10 });
  }

  async restart(): Promise<void> {
    const container = this.docker.getContainer(CONTAINER_NAME);
    await container.restart({ t: 10 });
  }

  async remove(): Promise<void> {
    const container = this.docker.getContainer(CONTAINER_NAME);
    try {
      await container.stop({ t: 5 });
    } catch {
    }
    await container.remove({ v: false });
  }

  async getStatus(): Promise<SandboxStatus> {
    try {
      const container = this.docker.getContainer(CONTAINER_NAME);
      const info = await container.inspect();
      if (info.State.Running) return 'running';
      if (info.State.Status === 'exited' || info.State.Status === 'stopped') return 'stopped';
      return 'unknown';
    } catch (err: any) {
      if (err?.statusCode === 404) return 'removed';
      return 'unknown';
    }
  }

  async create(opts: CreateSandboxOpts): Promise<ProvisionResult> {
    this._lastCreateOpts = opts;
    const info = await this.ensure();
    return {
      externalId: info.name,
      baseUrl: info.baseUrl,
      metadata: {
        containerName: info.name,
        containerId: info.containerId,
        image: info.image,
        mappedPorts: info.mappedPorts,
        version: SANDBOX_VERSION,
      },
    };
  }

  async resolveEndpoint(externalId: string): Promise<ResolvedEndpoint> {
    const url = config.SANDBOX_NETWORK
      ? `http://${externalId}:8000`
      : BASE_URL;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (config.INTERNAL_SERVICE_KEY) {
      headers['Authorization'] = `Bearer ${config.INTERNAL_SERVICE_KEY}`;
    }

    return { url, headers };
  }

  async ensureRunning(_externalId: string): Promise<void> {
    const info = await this.find();
    if (info && info.status === 'running') {
      await this.syncCoreEnvVars();
      return;
    }
    if (info) {
      const container = this.docker.getContainer(CONTAINER_NAME);
      await container.start();
      await this.syncCoreEnvVars();
      return;
    }
    await this.ensure();
  }

  /**
   * Sync the non-auth core env vars to the sandbox via the secrets manager API.
   *
   * Uses kortix-master's /env endpoint which does triple-write:
   *   1. SecretStore (.secrets.json — encrypted at rest)
   *   2. s6 env dir  (/run/s6/container_environment/ — tools read this on every call)
   *   3. process.env (kortix-master's own process)
   *
   * Since getEnv() reads s6 first (always fresh from disk), updated values
   * take effect immediately — no service restart needed.
   * Only POSTs when values actually differ from what's currently set.
   *
   * Auth aliases (KORTIX_TOKEN / INTERNAL_SERVICE_KEY / TUNNEL_TOKEN) are
   * synced separately from the canonical sandbox service key in the DB.
   */
  async syncCoreEnvVars(): Promise<void> {
    if (this._serviceKeySynced) return;

    const info = await this.find();
    if (!info || info.status !== 'running') {
      return;
    }

    const sandboxApiBase = getSandboxInternalApiUrl();
    const desired: Record<string, string> = {
      KORTIX_API_URL: sandboxApiBase,
      TUNNEL_API_URL: sandboxApiBase,
    };

    // Read current state from the live master env (s6 env dir) — NOT from
    // Docker inspect which only has stale creation-time values.
    const authCandidates = getAuthCandidates(await this.getCanonicalServiceKey());
    let currentEnv: Record<string, string> = {};
    try {
      currentEnv = await this.fetchMasterEnv(authCandidates);
    } catch {
      // Master not ready yet — fall back to Docker inspect for URL/key only
      const containerEnv = await this.getContainerEnv();
      currentEnv = {};
      for (const key of Object.keys(desired)) {
        currentEnv[key] = containerEnv[key] || '';
      }
    }

    const stale: Record<string, string> = {};
    for (const [key, val] of Object.entries(desired)) {
      if (val && currentEnv[key] !== val) {
        stale[key] = val;
      }
    }

    if (Object.keys(stale).length === 0) {
      this._serviceKeySynced = true;
      return;
    }

    try {
      await this.postMasterEnv(stale, authCandidates);
      this._serviceKeySynced = true;
    } catch (err: any) {
      console.error('[LOCAL-DOCKER] Failed to sync core env vars via /env API, falling back to docker exec:', err.message || err);
      try {
        this.syncCoreEnvVarsFallback(stale);
        this._serviceKeySynced = true;
      } catch (fallbackErr: any) {
        console.error('[LOCAL-DOCKER] Fallback sync also failed:', fallbackErr.message || fallbackErr);
      }
    }
  }

  /**
   * GET /env from kortix-master — returns all current env vars.
   */
  private async fetchMasterEnv(authCandidates: string[]): Promise<Record<string, string>> {
    const url = `http://localhost:${config.SANDBOX_PORT_BASE || 14000}/env`;
    for (const token of authCandidates) {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        return (await res.json()) as Record<string, string>;
      }
    }
    throw new Error('GET /env returned unauthorized for all auth candidates');
  }

  /**
   * POST /env to kortix-master — sets env vars via the secrets manager.
   * No restart needed: getEnv() reads s6 env dir directly on every call.
   */
  private async postMasterEnv(keys: Record<string, string>, authCandidates: string[]): Promise<void> {
    const url = `http://localhost:${config.SANDBOX_PORT_BASE || 14000}/env`;
    for (const token of authCandidates) {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ keys }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return;
    }
    throw new Error('POST /env returned unauthorized for all auth candidates');
  }

  /**
   * Fallback: write directly to s6 env dir via docker exec.
   * Used only when the /env API is unreachable (e.g. kortix-master not ready yet).
   */
  private syncCoreEnvVarsFallback(stale: Record<string, string>): void {
    const env = { ...process.env };
    if (config.DOCKER_HOST && !config.DOCKER_HOST.includes('://')) {
      env.DOCKER_HOST = `unix://${config.DOCKER_HOST}`;
    }

    const cmd =
      `docker exec ${shellQuote(CONTAINER_NAME)} bash -c ` +
      `${shellQuote(buildDockerEnvWriteCommand(stale, '/run/s6/container_environment'))}`;

    execSync(cmd, { timeout: 15_000, stdio: 'pipe', env });
  }

  /**
   * Push a KORTIX_TOKEN into a running container so it matches the DB.
   *
   * Called by ensure() when the caller (e.g. POST /init/local) registered a
   * new token in the DB but the container is already running with a stale one.
   * Uses the same /env API and docker-exec fallback as syncCoreEnvVars.
   */
  private async syncTokenToContainer(token: string): Promise<void> {
    const containerEnv = await this.getContainerEnv();
    if (
      containerEnv['KORTIX_TOKEN'] === token &&
      containerEnv['INTERNAL_SERVICE_KEY'] === token &&
      containerEnv['TUNNEL_TOKEN'] === token
    ) return;

    const authCandidates = getAuthCandidates(token);
    const authBundle = {
      KORTIX_TOKEN: token,
      INTERNAL_SERVICE_KEY: token,
      TUNNEL_TOKEN: token,
    };
    try {
      await this.postMasterEnv(authBundle, authCandidates);
    } catch {
      try {
        this.syncCoreEnvVarsFallback(authBundle);
      } catch (err: any) {
        console.error('[LOCAL-DOCKER] Failed to sync sandbox auth bundle into container:', err.message || err);
      }
    }
  }

  private async getCanonicalServiceKey(): Promise<string> {
    const dbKey = await getSandboxServiceKeyByExternalId(CONTAINER_NAME);
    return dbKey || this._lastCreateOpts?.envVars?.KORTIX_TOKEN || '';
  }

  private _lastCreateOpts?: CreateSandboxOpts;

  /**
   * Check if the sandbox image exists locally.
   */
  async hasImage(imageOverride?: string): Promise<boolean> {
    try {
      await this.docker.getImage(imageOverride || config.SANDBOX_IMAGE).inspect();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Pull the sandbox image with progress tracking.
   * Resolves when pull is complete. Updates _pullStatus throughout.
   */
  async pullImage(): Promise<void> {
    const image = config.SANDBOX_IMAGE;
    _pullStatus = { state: 'pulling', progress: 0, message: `Pulling ${image}...` };

    await new Promise<void>((resolve, reject) => {
      this.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) {
          _pullStatus = { state: 'error', progress: 0, message: err.message, error: err.message };
          return reject(err);
        }
        const layerProgress: Record<string, { current: number; total: number }> = {};
        this.docker.modem.followProgress(
          stream,
          (err2: Error | null) => {
            if (err2) {
              _pullStatus = { state: 'error', progress: 0, message: err2.message, error: err2.message };
              return reject(err2);
            }
            _pullStatus = { state: 'done', progress: 100, message: 'Image pulled successfully' };
            resolve();
          },
          (event: any) => {
            if (event.id && event.progressDetail?.total) {
              layerProgress[event.id] = {
                current: event.progressDetail.current || 0,
                total: event.progressDetail.total,
              };
              const layers = Object.values(layerProgress);
              const totalBytes = layers.reduce((s, l) => s + l.total, 0);
              const currentBytes = layers.reduce((s, l) => s + l.current, 0);
              const pct = totalBytes > 0 ? Math.round((currentBytes / totalBytes) * 100) : 0;
              _pullStatus = {
                state: 'pulling',
                progress: Math.min(pct, 99),
                message: `Pulling image... ${pct}%`,
              };
            } else if (event.status) {
              _pullStatus = { ..._pullStatus, message: event.status };
            }
          },
        );
      });
    });
  }

  private async createContainer(): Promise<void> {
    const image = config.SANDBOX_IMAGE;
    if (!(await this.hasImage(image))) {
      await this.pullImage();
    }

    let authToken = this._lastCreateOpts?.envVars?.KORTIX_TOKEN || '';
    if (!authToken) {
      authToken = generateSandboxKeyPair().secretKey;
    }
    const sandboxEnvVars = readSandboxEnv();

    const serviceKey = authToken;

    // Vars we set explicitly below — don't let the forwarded .env duplicate them.
    const MANAGED_VARS = new Set([
      'KORTIX_TOKEN',
      'KORTIX_API_URL',
      'TUNNEL_API_URL',
      'TUNNEL_TOKEN',
      'SANDBOX_ID',
      'SANDBOX_VERSION',
      'INTERNAL_SERVICE_KEY',
      'PROJECT_ID',
      'CORS_ALLOWED_ORIGINS',
    ]);

    // Forward the developer's non-secret env, but NEVER a real provider secret.
    // The sandbox reaches every upstream (LLM gateway, Tavily, …) through the
    // kortix-api router with its KORTIX_TOKEN — it must not hold raw keys.
    const filteredSandboxEnv = sandboxEnvVars.filter((entry) => {
      const varName = entry.split('=')[0];
      if (MANAGED_VARS.has(varName)) return false;
      if (isForbiddenSandboxEnv(varName)) return false;
      return true;
    });
    const sandboxApiBase = getSandboxInternalApiUrl();

    const env = [
      'PUID=911',
      'PGID=911',
      'TZ=Etc/UTC',
      'SUBFOLDER=/',
      'TITLE=Kortix Sandbox',
      'OPENCODE_CONFIG_DIR=/ephemeral/kortix-master/opencode',
      'OPENCODE_PERMISSION={"*":"allow"}',
      'DISPLAY=:1',
      'LSS_DIR=/persistent/lss',
      'KORTIX_WORKSPACE=/workspace',
      'PYTHONUSERBASE=/workspace/.local',
      'PIP_USER=1',
      'NPM_CONFIG_PREFIX=/workspace/.npm-global',
      // ── Persistent secret paths (aligned with startup.sh persistent model) ──
      'SECRET_FILE_PATH=/persistent/secrets/.secrets.json',
      'SALT_FILE_PATH=/persistent/secrets/.salt',
      'ENCRYPTION_KEY_PATH=/persistent/secrets/.encryption-key',
      `KORTIX_API_URL=${sandboxApiBase}`,
      `KORTIX_TOKEN=${authToken}`,
      `INTERNAL_SERVICE_KEY=${serviceKey}`,
      `TUNNEL_API_URL=${sandboxApiBase}`,
      `TUNNEL_TOKEN=${authToken}`,
      `SANDBOX_ID=${CONTAINER_NAME}`,
      // Inject the API's own version so the sandbox health endpoint reports correctly.
      // All components share one version (set by deploy-zero-downtime.sh from image tag).
      `SANDBOX_VERSION=${SANDBOX_VERSION}`,
      'PROJECT_ID=local',
      ...(config.KORTIX_LOCAL_IMAGES ? ['KORTIX_LOCAL_SOURCE=1'] : []),
      `CORS_ALLOWED_ORIGINS=${[config.FRONTEND_URL, config.KORTIX_URL].filter(Boolean).join(',')}`,
      ...filteredSandboxEnv,
      // The in-sandbox `kortix` CLI authenticates with the project-scoped PAT
      // (KORTIX_CLI_TOKEN), not KORTIX_TOKEN (the service key). Forward it so
      // `kortix cr open` / `secrets` / … work in local sandboxes too — parity
      // with the cloud provider. Appended last so it wins over any stray local
      // value. See apps/api/src/platform/services/session-sandbox.ts.
      ...(this._lastCreateOpts?.envVars?.KORTIX_CLI_TOKEN
        ? [`KORTIX_CLI_TOKEN=${this._lastCreateOpts.envVars.KORTIX_CLI_TOKEN}`]
        : []),
      ...(this._lastCreateOpts?.envVars?.KORTIX_EXECUTOR_TOKEN
        ? [`KORTIX_EXECUTOR_TOKEN=${this._lastCreateOpts.envVars.KORTIX_EXECUTOR_TOKEN}`]
        : []),
    ];

    const container = await this.docker.createContainer({
      Image: image,
      name: CONTAINER_NAME,
      Env: env,
      ExposedPorts: EXPOSED_PORTS,
      HostConfig: {
        PortBindings: PORT_BINDINGS,
        Privileged: true,
        ShmSize: 2 * 1024 * 1024 * 1024,
        RestartPolicy: { Name: 'unless-stopped' },
        Binds: [
          `${CONTAINER_NAME}-data:/workspace`,
          `${CONTAINER_NAME}-data:/config`,
        ],
        ...(config.SANDBOX_NETWORK ? { NetworkMode: config.SANDBOX_NETWORK } : {}),
      },
      Labels: {
        'kortix.sandbox': 'true',
        'kortix.account': 'local',
        'kortix.user': 'local',
      },
    });

    await container.start();
  }

  /**
   * Read environment variables from the running container via Docker inspect.
   * Returns a map of VAR_NAME → value.
   */
  async getContainerEnv(): Promise<Record<string, string>> {
    try {
      const container = this.docker.getContainer(CONTAINER_NAME);
      const info = await container.inspect();
      const envList = info.Config.Env || [];
      const result: Record<string, string> = {};
      for (const entry of envList) {
        const eqIdx = entry.indexOf('=');
        if (eqIdx > 0) {
          result[entry.slice(0, eqIdx)] = entry.slice(eqIdx + 1);
        }
      }
      return result;
    } catch {
      return {};
    }
  }

  private toSandboxInfo(info: Docker.ContainerInspectInfo): SandboxInfo {
    const status: SandboxStatus =
      info.State.Running ? 'running' :
      info.State.Status === 'exited' || info.State.Status === 'created' ? 'stopped' :
      'unknown';

    return {
      containerId: info.Id,
      name: CONTAINER_NAME,
      status,
      image: info.Config.Image || config.SANDBOX_IMAGE,
      baseUrl: BASE_URL,
      mappedPorts: { ...PORT_MAP },
      createdAt: info.Created,
    };
  }

}

interface SandboxInfo {
  containerId: string;
  name: string;
  status: SandboxStatus;
  image: string;
  baseUrl: string;
  mappedPorts: Record<string, string>;
  createdAt: string;
}
