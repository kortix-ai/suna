import { createHash } from 'node:crypto';
import {
  buildSandboxUpstreamHeaders,
  resolveSandboxIngress,
  type SandboxRecord,
} from './backend';

const POSITIVE_TTL_MS = 15_000;
const NEGATIVE_TTL_MS = 2_000;
const MAX_CACHE_ENTRIES = 256;

type CapabilityRecord = Pick<
  SandboxRecord,
  'sandboxId' | 'externalId' | 'provider' | 'serviceKey'
>;

interface Dependencies {
  now?: () => number;
  timeoutMs?: number;
  resolveIngress?: typeof resolveSandboxIngress;
  buildHeaders?: typeof buildSandboxUpstreamHeaders;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export function createPreviewBridgeCapabilityResolver(deps: Dependencies = {}) {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? 1_000;
  const ingressResolver = deps.resolveIngress ?? resolveSandboxIngress;
  const headerBuilder = deps.buildHeaders ?? buildSandboxUpstreamHeaders;
  const fetcher = deps.fetch ?? globalThis.fetch;
  const cache = new Map<string, { supported: boolean; expiresAt: number; ingressIdentity?: string }>();
  const pending = new Map<string, Promise<boolean>>();

  return async (record: CapabilityRecord): Promise<boolean> => {
    // Legacy daemons can still serve direct app ports without a service key.
    if (!record.serviceKey) return false;
    const keyDigest = createHash('sha256').update(record.serviceKey).digest('base64url');
    const key = [record.sandboxId, record.externalId, record.provider, keyDigest].join(':');
    const cached = cache.get(key);
    if (cached && now() < cached.expiresAt) return cached.supported;
    cache.delete(key);

    const existing = pending.get(key);
    if (existing) return existing;
    // Do not let a burst across distinct sandboxes create an unbounded set of
    // provider calls. A saturated discovery gate preserves legacy ingress.
    if (pending.size >= MAX_CACHE_ENTRIES) return false;
    const probe = (async (): Promise<boolean> => {
      const controller = new AbortController();
      const operation = (async () => {
        const ingress = await ingressResolver(record as SandboxRecord, {
          port: 8000,
          path: '/kortix/health',
          transport: 'http',
        });
        const headers = await headerBuilder({
          sandboxId: record.externalId,
          userId: '',
          serviceKey: record.serviceKey,
          providerHeaders: ingress.headers,
        });
        const response = await fetcher(`${ingress.url.replace(/\/$/, '')}/kortix/health`, {
          headers,
          signal: controller.signal,
        });
        if (!response.ok) return { supported: false, ingressIdentity: ingress.url };
        const body = await response.json().catch(() => null) as {
          capabilities?: { localhost_preview_bridge?: unknown };
        } | null;
        return {
          supported: body?.capabilities?.localhost_preview_bridge === 1,
          ingressIdentity: ingress.url,
        };
      })().catch(() => ({ supported: false, ingressIdentity: undefined }));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(null);
        }, timeoutMs);
      });
      const result = await Promise.race([operation, deadline]);
      if (timer) clearTimeout(timer);
      const supported = result?.supported === true;
      if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
      cache.set(key, {
        supported,
        expiresAt: now() + (supported ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
        ingressIdentity: result?.ingressIdentity,
      });
      return supported;
    })();
    pending.set(key, probe);
    try {
      return await probe;
    } finally {
      pending.delete(key);
    }
  };
}

export const supportsPreviewBridge = createPreviewBridgeCapabilityResolver();
