import Docker from 'dockerode';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { config, SANDBOX_VERSION } from '../../config';
import { generateSandboxKeyPair } from '../../shared/crypto';
import { getAuthCandidates, getSandboxServiceKeyByExternalId } from '../services/sandbox-auth';
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

export interface ImagePullStatus {
  state: 'idle' | 'pulling' | 'done' | 'error';
  progress: number;
  message: string;
  error?: string;
}

let _pullStatus: ImagePullStatus = { state: 'idle', progress: 0, message: '' };

export function getImagePullStatus(): ImagePullStatus {
  return { ..._pullStatus };
}

export type SandboxUpdatePhase =
  | 'idle'
  | 'pulling'
  | 'stopping'
  | 'removing'
  | 'recreating'
  | 'starting'
  | 'health_check'
  | 'complete'
  | 'failed';

export interface SandboxUpdateStatus {
  phase: SandboxUpdatePhase;
  progress: number;
  message: string;
  targetVersion: string | null;
  previousVersion: string | null;
  currentVersion: string | null;
  error: string | null;
  startedAt: string | null;
  updatedAt: string | null;
}

const IDLE_UPDATE_STATUS: SandboxUpdateStatus = {
  phase: 'idle',
  progress: 0,
  message: '',
  targetVersion: null,
  previousVersion: null,
  currentVersion: null,
  error: null,
  startedAt: null,
  updatedAt: null,
};

let _updateStatus: SandboxUpdateStatus = { ...IDLE_UPDATE_STATUS };

export function getSandboxUpdateStatus(): SandboxUpdateStatus {
  return { ..._updateStatus };
}

export function resetSandboxUpdateStatus(): void {
  _updateStatus = { ...IDLE_UPDATE_STATUS };
}

function setUpdateStatus(partial: Partial<SandboxUpdateStatus>): void {
  _updateStatus = { ..._updateStatus, ...partial, updatedAt: new Date().toISOString() };
}

/**
 * Derive the target image name from a version string.
 * Uses the current SANDBOX_IMAGE config as the base (strips existing tag).
 * e.g. "kortix/computer:0.7.5" + version "0.8.0" → "kortix/computer:0.8.0"
 */
function getImageForVersion(version: string): string {
  const current = config.SANDBOX_IMAGE;
  const colonIdx = current.lastIndexOf(':');
  const base = colonIdx > 0 ? current.slice(0, colonIdx) : current;
  return `${base}:${version}`;
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

  async getProvisioningStatus(sandboxId: string): Promise<ProvisioningStatus | null> {
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
      console.log(`[LOCAL-DOCKER] Starting stopped sandbox...`);
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

    console.log(`[LOCAL-DOCKER] Creating sandbox (image: ${config.SANDBOX_IMAGE})...`);
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

  /**
   * Update the sandbox to a new Docker image version.
   *
   * Flow: pull new image → stop container → remove container (preserve volumes)
   *       → recreate container with new image → start → health check.
   *
   * The /workspace volume is preserved across the recreate (v: false on remove).
   * Returns the new SandboxInfo on success, throws on failure.
   */
  async updateSandbox(targetVersion: string): Promise<SandboxInfo> {
    if (_updateStatus.phase !== 'idle' && _updateStatus.phase !== 'complete' && _updateStatus.phase !== 'failed') {
      throw new Error(`Update already in progress (phase: ${_updateStatus.phase})`);
    }

    const targetImage = getImageForVersion(targetVersion);
    let previousVersion: string | null = null;

    try {
      const existing = await this.find();
      if (existing) {
        const currentTag = existing.image.split(':').pop() || null;
        previousVersion = currentTag;
      }

      setUpdateStatus({
        phase: 'pulling',
        progress: 10,
        message: `Checking image ${targetImage}...`,
        targetVersion,
        previousVersion,
        currentVersion: previousVersion,
        error: null,
        startedAt: new Date().toISOString(),
      });
      let imageExistsLocally = false;
      try {
        await this.docker.getImage(targetImage).inspect();
        imageExistsLocally = true;
        console.log(`[LOCAL-DOCKER] Image ${targetImage} already exists locally, skipping pull`);
        setUpdateStatus({ progress: 50, message: `Image ${targetImage} found locally` });
      } catch {
      }

      if (!imageExistsLocally) {
        console.log(`[LOCAL-DOCKER] Pulling image ${targetImage} for update...`);
        setUpdateStatus({ message: `Pulling image ${targetImage}...` });
        await this.pullImageByName(targetImage);
      }

      setUpdateStatus({ phase: 'stopping', progress: 50, message: 'Stopping sandbox...' });
      console.log(`[LOCAL-DOCKER] Stopping sandbox for update...`);
      try {
        const container = this.docker.getContainer(CONTAINER_NAME);
        await container.stop({ t: 15 });
      } catch (err: any) {
        if (!err?.message?.includes('not running') && !err?.message?.includes('No such container')) {
          console.warn(`[LOCAL-DOCKER] Stop warning: ${err.message}`);
        }
      }

      setUpdateStatus({ phase: 'removing', progress: 60, message: 'Removing old container...' });
      console.log(`[LOCAL-DOCKER] Removing old container (preserving volumes)...`);
      try {
        const container = this.docker.getContainer(CONTAINER_NAME);
        await container.remove({ v: false, force: true });
      } catch (err: any) {
        if (err?.statusCode !== 404) {
          console.warn(`[LOCAL-DOCKER] Remove warning: ${err.message}`);
        }
      }
      console.log(`[LOCAL-DOCKER] Preparing volume for new container...`);
      try {
        const cleanupContainer = await this.docker.createContainer({
          Image: 'alpine:latest',
          Cmd: ['sh', '-c', [
            // Use 911:911 (abc user from linuxserver base image), NOT 1000
            'for p in /workspace/.secrets /workspace/.lss; do if [ -L "$p" ] && [ "$(readlink "$p" 2>/dev/null || true)" = "$p" ]; then rm -f "$p"; fi; done',
            'chown -R 911:911 /workspace 2>/dev/null || true',
            'find /workspace -name "*.db-wal" -o -name "*.db-shm" 2>/dev/null | xargs rm -f',
            'echo "volume prepared"',
          ].join(' && ')],
          HostConfig: {
            Binds: [`${CONTAINER_NAME}-data:/workspace`],
          },
        });
        await cleanupContainer.start();
        await cleanupContainer.wait();
        await cleanupContainer.remove().catch(() => {});
        console.log(`[LOCAL-DOCKER] Volume prepared (ownership + WAL cleanup)`);
      } catch (cleanErr: any) {
        console.warn(`[LOCAL-DOCKER] Volume prep warning: ${cleanErr.message}`);
      }

      setUpdateStatus({ phase: 'recreating', progress: 70, message: `Recreating with ${targetImage}...` });
      console.log(`[LOCAL-DOCKER] Recreating sandbox with image ${targetImage}...`);
      this._serviceKeySynced = false;
      await this.createContainer(targetImage);

      setUpdateStatus({ phase: 'starting', progress: 80, message: 'Container starting...' });
      console.log(`[LOCAL-DOCKER] Container created, starting up...`);

      setUpdateStatus({ phase: 'health_check', progress: 90, message: 'Waiting for sandbox to become healthy...' });
      console.log(`[LOCAL-DOCKER] Waiting for sandbox health check...`);
      await this.waitForHealth(120_000);

      setUpdateStatus({
        phase: 'complete',
        progress: 100,
        message: `Updated to v${targetVersion}`,
        currentVersion: targetVersion,
      });
      console.log(`[LOCAL-DOCKER] Sandbox updated to ${targetImage} successfully`);

      return this.getSandboxInfo();
    } catch (err: any) {
      const errorMsg = err?.message || String(err);
      setUpdateStatus({
        phase: 'failed',
        progress: 0,
        message: `Update failed: ${errorMsg}`,
        error: errorMsg,
      });
      console.error(`[LOCAL-DOCKER] Sandbox update failed:`, errorMsg);
      throw err;
    }
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
      console.log('[LOCAL-DOCKER] Container stopped, starting for cron execution...');
      const container = this.docker.getContainer(CONTAINER_NAME);
      await container.start();
      await this.syncCoreEnvVars();
      return;
    }
    console.log('[LOCAL-DOCKER] No container found, creating for cron execution...');
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
      console.log('[LOCAL-DOCKER] syncCoreEnvVars: no running container found, skipping');
      return;
    }

    const sandboxApiBase = getSandboxInternalApiUrl();
    const routerBase = `${sandboxApiBase}/v1/router`;
    const desired: Record<string, string> = {
      KORTIX_API_URL: sandboxApiBase,
      TUNNEL_API_URL: sandboxApiBase,
      // Tool proxy URLs — route through kortix-api router so sandbox tools
      // auth with KORTIX_TOKEN and the router injects real upstream API keys.
      TAVILY_API_URL: `${routerBase}/tavily`,
      REPLICATE_API_URL: `${routerBase}/replicate`,
      SERPER_API_URL: `${routerBase}/serper`,
      FIRECRAWL_API_URL: `${routerBase}/firecrawl`,
    };

    // Only inject CRW proxy URL when the backend has a CRW key configured.
    // Without this guard, sandbox tools would select CRW and get 503 "crw not configured".
    if (config.CRW_API_KEY) {
      desired.CRW_API_URL = `${routerBase}/crw`;
    }

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

    // Clean up stale CRW_API_URL from sandbox when CRW is no longer configured.
    // Without this, disabling CRW leaves an orphan URL that makes sandbox tools
    // select CRW and hit 503 "crw not configured".
    if (!desired.CRW_API_URL && currentEnv.CRW_API_URL) {
      stale.CRW_API_URL = '';  // empty value signals deletion to the env API
    }

    if (Object.keys(stale).length === 0) {
      this._serviceKeySynced = true;
      console.log('[LOCAL-DOCKER] syncCoreEnvVars: all core vars in sync');
      return;
    }

    console.log(`[LOCAL-DOCKER] Syncing ${Object.keys(stale).join(', ')} via secrets manager...`);
    try {
      await this.postMasterEnv(stale, authCandidates);
      this._serviceKeySynced = true;
      console.log(`[LOCAL-DOCKER] Core env vars synced: ${Object.keys(stale).join(', ')}`);
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
    console.log(`[LOCAL-DOCKER] Core env vars synced via fallback (docker exec): ${Object.keys(stale).join(', ')}`);
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

    console.log('[LOCAL-DOCKER] Syncing DB-registered KORTIX_TOKEN into running container...');
    const authCandidates = getAuthCandidates(token);
    const authBundle = {
      KORTIX_TOKEN: token,
      INTERNAL_SERVICE_KEY: token,
      TUNNEL_TOKEN: token,
    };
    try {
      await this.postMasterEnv(authBundle, authCandidates);
      console.log('[LOCAL-DOCKER] Sandbox auth bundle synced to container via /env API');
    } catch {
      try {
        this.syncCoreEnvVarsFallback(authBundle);
        console.log('[LOCAL-DOCKER] Sandbox auth bundle synced to container via docker exec fallback');
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
            console.log(`[LOCAL-DOCKER] Image ${image} pulled successfully`);
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

  /**
   * Pull a specific image by full name (e.g. "kortix/computer:0.8.0").
   * Updates both _pullStatus and _updateStatus with progress.
   */
  private async pullImageByName(imageName: string): Promise<void> {
    _pullStatus = { state: 'pulling', progress: 0, message: `Pulling ${imageName}...` };

    await new Promise<void>((resolve, reject) => {
      this.docker.pull(imageName, (err: Error | null, stream: NodeJS.ReadableStream) => {
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
            console.log(`[LOCAL-DOCKER] Image ${imageName} pulled successfully`);
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
              setUpdateStatus({
                progress: 10 + Math.round(pct * 0.4),
                message: `Pulling image... ${pct}%`,
              });
            } else if (event.status) {
              _pullStatus = { ..._pullStatus, message: event.status };
            }
          },
        );
      });
    });
  }

  private async createContainer(imageOverride?: string): Promise<void> {
    const image = imageOverride || config.SANDBOX_IMAGE;
    if (!(await this.hasImage(image))) {
      console.log(`[LOCAL-DOCKER] Image ${image} not found locally, pulling...`);
      await this.pullImage();
    }

    let authToken = this._lastCreateOpts?.envVars?.KORTIX_TOKEN || '';
    if (!authToken) {
      authToken = generateSandboxKeyPair().secretKey;
    }
    const sandboxEnvVars = readSandboxEnv();

    const serviceKey = authToken;

    const MANAGED_VARS = new Set([
      'KORTIX_TOKEN',
      'KORTIX_API_URL',
      'SANDBOX_ID',
      'INTERNAL_SERVICE_KEY',
      'PROJECT_ID',
      'ENV_MODE',
      'CORS_ALLOWED_ORIGINS',
      'CRW_API_URL',
      'TAVILY_API_URL',
      'REPLICATE_API_URL',
      'SERPER_API_URL',
      'FIRECRAWL_API_URL',
    ]);

    const filteredSandboxEnv = sandboxEnvVars.filter((entry) => {
      const varName = entry.split('=')[0];
      return !MANAGED_VARS.has(varName);
    });

    const sandboxApiBase = getSandboxInternalApiUrl();
    const routerBase = `${sandboxApiBase}/v1/router`;

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
      // ── Tool proxy URLs — route through kortix-api router ─────────────
      // Sandbox tools use KORTIX_TOKEN to auth; the router injects the real
      // upstream API key. Matches cloud provider env injection (justavps/daytona/pool).
      `TAVILY_API_URL=${routerBase}/tavily`,
      `REPLICATE_API_URL=${routerBase}/replicate`,
      `SERPER_API_URL=${routerBase}/serper`,
      `FIRECRAWL_API_URL=${routerBase}/firecrawl`,
      // Only inject CRW proxy URL when the backend has a CRW key configured.
      ...(config.CRW_API_KEY ? [`CRW_API_URL=${routerBase}/crw`] : []),
      ...(config.KORTIX_LOCAL_IMAGES ? ['KORTIX_LOCAL_SOURCE=1'] : []),
      `ENV_MODE=${config.KORTIX_BILLING_INTERNAL_ENABLED ? 'cloud' : 'local'}`,
      `CORS_ALLOWED_ORIGINS=${[config.FRONTEND_URL, config.KORTIX_URL].filter(Boolean).join(',')}`,
      ...filteredSandboxEnv,
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
    console.log(
      `[LOCAL-DOCKER] Sandbox created and started on ports ${PORT_BASE}-${PORT_BASE + 7}`,
    );
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

  /**
   * Wait for the sandbox to pass health checks.
   * Polls GET /kortix/health until it returns 200 with status "ok".
   */
  private async waitForHealth(timeoutMs: number): Promise<void> {
    const start = Date.now();
    const healthUrl = `http://localhost:${PORT_MAP['8000']}/kortix/health`;

    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000) });
        if (res.ok) {
          const data = await res.json() as any;
          if (data.status === 'ok') {
            console.log(`[LOCAL-DOCKER] Health check passed`);
            return;
          }
        }
      } catch {
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }
    throw new Error(`Health check timed out after ${Math.round(timeoutMs / 1000)}s — sandbox may still be starting`);
  }
}

export interface SandboxInfo {
  containerId: string;
  name: string;
  status: SandboxStatus;
  image: string;
  baseUrl: string;
  mappedPorts: Record<string, string>;
  createdAt: string;
}
