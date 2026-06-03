/**
 * Freestyle (https://docs.freestyle.sh/v2/serverless/deployments) adapter
 * for the DeploymentProvider interface.
 *
 * Anything Freestyle-specific lives in this file.
 */
import { config } from '../../config';
import type {
  AppBuild,
  AppSource,
  DeploymentProvider,
  DeploymentRequest,
  DeploymentResult,
} from './types';

// ─── Dynamic Freestyle config ────────────────────────────────────────────────
// The Kortix API runs in a separate container from the sandbox. API keys set
// via the Secrets Manager are stored in the sandbox's secret store (Kortix
// Master /env). We fetch them from there at deploy-time so keys set after
// startup work without restarting the API service.

function getMasterUrlCandidates(): string[] {
  const candidates: string[] = [];
  const explicit = config.KORTIX_MASTER_URL;
  if (explicit?.trim()) candidates.push(explicit.trim());
  candidates.push('http://sandbox:8000');
  candidates.push(`http://localhost:${config.SANDBOX_PORT_BASE || 14000}`);
  return Array.from(new Set(candidates));
}

/** Try to read a single secret from the sandbox's Kortix Master /env/:key endpoint. */
async function readSandboxSecret(key: string): Promise<string> {
  const candidates = getMasterUrlCandidates();
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  const headers: Record<string, string> = {};
  if (serviceKey) headers['Authorization'] = `Bearer ${serviceKey}`;

  for (const base of candidates) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${base}/env/${encodeURIComponent(key)}`, {
        headers,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const data = await res.json();
      const val = data?.[key] ?? data?.secrets?.[key] ?? '';
      if (typeof val === 'string' && val.trim()) return val.trim();
    } catch { /* try next candidate */ }
  }
  return '';
}

// Cache the fetched key for 60s to avoid hammering the sandbox on every request.
let _cachedFreestyleKey = '';
let _cachedFreestyleKeyAt = 0;
const CACHE_TTL_MS = 60_000;

async function getFreestyleApiKey(): Promise<string> {
  if (process.env.FREESTYLE_API_KEY) return process.env.FREESTYLE_API_KEY;
  if (config.FREESTYLE_API_KEY) return config.FREESTYLE_API_KEY;
  const now = Date.now();
  if (_cachedFreestyleKey && (now - _cachedFreestyleKeyAt) < CACHE_TTL_MS) {
    return _cachedFreestyleKey;
  }
  const val = await readSandboxSecret('FREESTYLE_API_KEY');
  if (val) {
    _cachedFreestyleKey = val;
    _cachedFreestyleKeyAt = now;
  }
  return val;
}

function getFreestyleApiUrl(): string {
  return process.env.FREESTYLE_API_URL || config.FREESTYLE_API_URL || 'https://api.freestyle.sh';
}

/** Low-level Freestyle REST call. Returns the raw Response. */
async function callFreestyle(
  path: string,
  options: { method: string; body?: unknown; timeoutMs?: number },
): Promise<Response> {
  const apiKey = await getFreestyleApiKey();
  const url = `${getFreestyleApiUrl()}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 120000);

  try {
    const response = await fetch(url, {
      method: options.method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return response;
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

// ─── Adapter implementation ─────────────────────────────────────────────────

function buildSourceFromAppSource(source: AppSource) {
  if (source.type === 'git') {
    return {
      kind: 'git' as const,
      url: source.repo,
      branch: source.branch,
      dir: source.rootPath,
    };
  }
  return {
    kind: 'tar' as const,
    url: source.url,
  };
}

function buildConfigFromAppRequest(req: DeploymentRequest) {
  // Build defaulting:
  //   - explicit [apps.build] with fields → forward as-is so command/outDir/envVars hit Freestyle
  //   - explicit [apps.build] but empty   → `true` (let Freestyle auto-detect framework)
  //   - no [apps.build] at all, git src   → `true` (most templates need a build to expose an entrypoint —
  //     the fly.toml-style ergonomic the user asked for)
  //   - no [apps.build] at all, tar src   → omit (tarball already contains the built artifact)
  let build: AppBuild | boolean | undefined;
  if (req.build && (req.build.command || req.build.outDir || req.build.envVars)) {
    build = req.build;
  } else if (req.build !== undefined) {
    build = true;
  } else if (req.source.type === 'git') {
    build = true;
  } else {
    build = undefined;
  }
  return {
    await: true,
    domains: req.domains,
    build,
    envVars: req.env,
  };
}

export const freestyleProvider: DeploymentProvider = {
  name: 'freestyle',

  async deploy(req: DeploymentRequest): Promise<DeploymentResult> {
    if (!(await getFreestyleApiKey())) {
      return {
        providerId: '',
        liveUrl: null,
        status: 'failed',
        error: 'Freestyle API key not configured',
      };
    }

    const body = {
      source: buildSourceFromAppSource(req.source),
      config: buildConfigFromAppRequest(req),
    };

    let response: Response;
    try {
      response = await callFreestyle('/web/v1/deployment', {
        method: 'POST',
        body,
        // 5 min — real builds (Go, Rust, frontend bundlers) can take a while.
        timeoutMs: 300_000,
      });
    } catch (err) {
      return {
        providerId: '',
        liveUrl: null,
        status: 'failed',
        error: err instanceof Error ? err.message : 'Freestyle API unreachable',
      };
    }

    if (!response.ok) {
      const text = await response.text().catch(() => 'Unknown Freestyle error');
      let message = text;
      try {
        const parsed = JSON.parse(text);
        message = parsed.message || parsed.description || text;
      } catch { /* keep raw text */ }
      return { providerId: '', liveUrl: null, status: 'failed', error: message };
    }

    const result = await response.json();
    return {
      providerId: String(result.deploymentId ?? ''),
      liveUrl: req.domains[0] ? `https://${req.domains[0]}` : null,
      status: 'active',
    };
  },

  async stop(providerId: string): Promise<void> {
    if (!providerId) return;
    if (!(await getFreestyleApiKey())) return;
    try {
      await callFreestyle(`/web/v1/deployment/${providerId}`, {
        method: 'DELETE',
        timeoutMs: 15_000,
      });
    } catch {
      // Best-effort.
    }
  },

  async logs(providerId: string): Promise<unknown> {
    if (!providerId) return { logs: [] };
    if (!(await getFreestyleApiKey())) {
      throw new Error('Freestyle API key not configured');
    }
    const response = await callFreestyle(
      `/observability/v1/logs?deploymentId=${encodeURIComponent(providerId)}`,
      { method: 'GET', timeoutMs: 15_000 },
    );
    return response.json();
  },
};
