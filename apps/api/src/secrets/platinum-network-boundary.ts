import { createHash, createHmac } from 'node:crypto';

import { platinumJson } from '../shared/platinum';
import type { NetworkBoundarySecretBinding } from './network-boundary';

type PlatinumSecret = {
  id: string;
  name: string;
  description: string | null;
  current_gen: number;
  allow: string[];
  headers: string[];
  on_echo: 'block' | 'redact';
};

export type PlatinumSandboxSecrets = {
  sandbox_id: string;
  state: 'armed' | 'arming' | 'unavailable';
  secrets: Array<{ secret_id: string; state: 'armed' | 'arming' | 'unavailable' }>;
};

const DESCRIPTION_PREFIX = 'kortix-network-v1';
/**
 * Wall-clock budget for the edge to report `armed`, and the backoff used to get
 * there. This replaced a fixed 40 x 250ms attempt count, which was a budget in
 * name only: it also paid 40 sequential round-trips, so the real ceiling was
 * 10s PLUS provider latency, and it hammered the provider with 40 GETs.
 *
 * 45s because the old 10s was simply below the provider's real latency, which is
 * why arming a boundary secret failed provisioning outright. Measured against
 * api.platinum.dev on a live dev sandbox: PUT returned `arming` in 1.9s and the
 * edge reported `armed` after **17s**. 45s leaves room for a slower day without
 * waiting forever. Session provisioning already takes ~40-60s and is fail-closed
 * here on purpose, so it can afford the wait; the user's turn cannot, which is
 * why the prompt path bounds its own patience instead of shortening this.
 *
 * The budget stays generous because the caller that must NOT proceed without an
 * armed edge — session provision (platform/services/session-sandbox.ts) — has to
 * either arm or fail. Callers on a user's hot path must not adopt this as their
 * own patience: they bound their own wait and let the arm finish in the
 * background (see PROMPT_BOUNDARY_ARM_WAIT_MS in
 * projects/lib/sandbox-env-sync.ts).
 */
const ARM_TIMEOUT_MS = 45_000;
const ARM_POLL_MIN_MS = 150;
const ARM_POLL_MAX_MS = 1_000;

function httpStatus(error: unknown): number | null {
  const match = String(error instanceof Error ? error.message : error).match(/ -> (\d{3})(?: |$)/);
  return match ? Number(match[1]) : null;
}

export interface PlatinumNetworkBoundaryContext {
  environment: string;
  rootSecret: string;
}

function replicaName(
  externalId: string,
  secretId: string,
  context: PlatinumNetworkBoundaryContext,
): string {
  const digest = createHash('sha256')
    .update(`${context.environment}\0${externalId}\0${secretId}`)
    .digest('hex');
  return `kortix-${digest.slice(0, 52)}`;
}

function fingerprint(value: string, context: PlatinumNetworkBoundaryContext): string {
  if (!context.rootSecret) throw new Error('API_KEY_SECRET is required for network secrets');
  return createHmac('sha256', context.rootSecret).update(value).digest('hex');
}

function policyFingerprint(
  binding: NetworkBoundarySecretBinding,
  context: PlatinumNetworkBoundaryContext,
): string {
  return fingerprint(JSON.stringify({
    hosts: [...binding.hosts].sort(),
    header: binding.header.toLowerCase(),
    onEcho: binding.onEcho,
  }), context);
}

function descriptionFor(
  binding: NetworkBoundarySecretBinding,
  context: PlatinumNetworkBoundaryContext,
): string {
  return `${DESCRIPTION_PREFIX} material=${fingerprint(binding.value, context)} policy=${policyFingerprint(binding, context)}`;
}

function descriptorFingerprints(description: string | null): {
  material: string | null;
  policy: string | null;
} {
  if (!description?.startsWith(`${DESCRIPTION_PREFIX} `)) {
    return { material: null, policy: null };
  }
  const material = description.match(/(?:^| )material=([a-f0-9]{64})(?: |$)/)?.[1] ?? null;
  const policy = description.match(/(?:^| )policy=([a-f0-9]{64})(?: |$)/)?.[1] ?? null;
  return { material, policy };
}


type PlatinumSecretPage = { items: PlatinumSecret[]; cursor: string | null };

const LIST_PAGE_SIZE = 100;
// A guard, not a limit: the organization holds one replica per (sandbox, secret),
// so paging is bounded in practice. Stopping is safer than looping forever if the
// provider ever returns a non-advancing cursor.
const LIST_MAX_PAGES = 50;

/**
 * Find a replica by NAME, the only way the provider supports it: page the list
 * and match. `?name=` is accepted and ignored (verified — it returns every
 * item), so the filter has to happen here.
 *
 * Pagination is `?limit=N&cursor=<last id>`, with `cursor: null` on the final
 * page.
 */
async function findSecretByName(name: string): Promise<PlatinumSecret | null> {
  let cursor: string | null = null;
  for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
    const query: string = cursor
      ? `?limit=${LIST_PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`
      : `?limit=${LIST_PAGE_SIZE}`;
    const res: PlatinumSecretPage = await platinumJson<PlatinumSecretPage>(`/v1/secrets${query}`);
    const hit = (res.items ?? []).find((item: PlatinumSecret) => item.name === name);
    if (hit) return hit;
    const next: string | null = res.cursor ?? null;
    if (!next || next === cursor) return null;
    cursor = next;
  }
  return null;
}

async function createSecret(
  name: string,
  binding: NetworkBoundarySecretBinding,
  context: PlatinumNetworkBoundaryContext,
): Promise<PlatinumSecret> {
  const body = {
    name,
    description: descriptionFor(binding, context),
    value: binding.value,
    allow: binding.hosts,
    headers: [binding.header],
    on_echo: binding.onEcho,
  };
  try {
    return await platinumJson<PlatinumSecret>('/v1/secrets', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (httpStatus(error) !== 409) throw error;
    // 409 `name_conflict` means the replica already exists. Resolve it by
    // LISTING — a read by name 404s, so the old recovery here always rethrew and
    // turned every re-arm into a failed sync.
    const raced = await findSecretByName(name);
    if (!raced) throw error;
    return raced;
  }
}

async function ensureSecret(
  externalId: string,
  binding: NetworkBoundarySecretBinding,
  context: PlatinumNetworkBoundaryContext,
): Promise<PlatinumSecret> {
  const name = replicaName(externalId, binding.secretId, context);
  let secret = await findSecretByName(name);
  if (!secret) return createSecret(name, binding, context);

  const stored = descriptorFingerprints(secret.description);
  const material = fingerprint(binding.value, context);
  const policy = policyFingerprint(binding, context);
  if (stored.material !== material) {
    secret = await platinumJson<PlatinumSecret>(`/v1/secrets/${secret.id}/versions`, {
      method: 'POST',
      body: JSON.stringify({ value: binding.value }),
    });
  }
  if (stored.policy !== policy || stored.material !== material) {
    secret = await platinumJson<PlatinumSecret>(`/v1/secrets/${secret.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        description: descriptionFor(binding, context),
        allow: binding.hosts,
        headers: [binding.header],
        on_echo: binding.onEcho,
      }),
    });
  }
  return secret;
}

async function waitUntilArmed(
  externalId: string,
  initial: PlatinumSandboxSecrets,
  timeoutMs: number,
): Promise<PlatinumSandboxSecrets> {
  let current = initial;
  let delayMs = ARM_POLL_MIN_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (current.state === 'armed') return current;
    if (current.state === 'unavailable') {
      throw new Error(`Platinum network-boundary secrets are unavailable for ${externalId}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Platinum network-boundary secrets did not arm for ${externalId} within ${timeoutMs}ms`,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    delayMs = Math.min(delayMs * 2, ARM_POLL_MAX_MS);
    current = await platinumJson<PlatinumSandboxSecrets>(
      `/v1/sandboxes/${encodeURIComponent(externalId)}/secrets`,
    );
  }
}

export interface PlatinumPreparedNetworkBoundary {
  secrets: Array<{ secret: string; alias: string; header: string }>;
}

export async function preparePlatinumNetworkBoundary(
  replicaOwnerId: string,
  bindings: NetworkBoundarySecretBinding[],
  context: PlatinumNetworkBoundaryContext,
): Promise<PlatinumPreparedNetworkBoundary> {
  const desired = await Promise.all(
    bindings.map(async (binding) => ({
      binding,
      secret: await ensureSecret(replicaOwnerId, binding, context),
    })),
  );
  return {
    secrets: desired.map(({ binding, secret }) => ({
      secret: secret.id,
      alias: binding.alias,
      header: binding.header,
    })),
  };
}

export async function waitForPlatinumNetworkBoundary(
  externalId: string,
  initial?: PlatinumSandboxSecrets,
  options?: { armTimeoutMs?: number },
): Promise<{ state: 'armed'; attached: number }> {
  const current = initial ?? await platinumJson<PlatinumSandboxSecrets>(
    `/v1/sandboxes/${encodeURIComponent(externalId)}/secrets`,
  );
  const armed = await waitUntilArmed(
    externalId,
    current,
    options?.armTimeoutMs ?? ARM_TIMEOUT_MS,
  );
  return { state: 'armed', attached: armed.secrets.length };
}

/**
 * Make the provider edge hold exactly `bindings` for this sandbox.
 *
 * Cost is real — one sandbox read, one read (and possibly a write) per binding,
 * one attachment write, then polling until the edge reports `armed`. Callers on
 * a hot path must not run it per request: `syncProviderNetworkBoundary` in
 * projects/lib/sandbox-env-sync.ts skips it when the desired set is byte-identical
 * to the last one it armed for this sandbox.
 *
 * `armTimeoutMs` overrides the wall-clock arm budget; production callers use the
 * default.
 */
export async function syncPlatinumNetworkBoundary(
  externalId: string,
  bindings: NetworkBoundarySecretBinding[],
  context: PlatinumNetworkBoundaryContext,
  options?: { armTimeoutMs?: number; replicaOwnerId?: string },
): Promise<{ state: 'armed'; attached: number }> {
  const sandboxPath = `/v1/sandboxes/${encodeURIComponent(externalId)}/secrets`;
  const before = await platinumJson<PlatinumSandboxSecrets>(sandboxPath);
  const desired = await Promise.all(
    bindings.map(async (binding) => ({
      binding,
      secret: await ensureSecret(options?.replicaOwnerId ?? externalId, binding, context),
    })),
  );
  const updated = await platinumJson<PlatinumSandboxSecrets>(sandboxPath, {
    method: 'PUT',
    body: JSON.stringify({
      secrets: desired.map(({ binding, secret }) => ({
        secret: secret.id,
        alias: binding.alias,
        header: binding.header,
      })),
    }),
  });
  if (desired.length > 0) {
    await waitUntilArmed(externalId, updated, options?.armTimeoutMs ?? ARM_TIMEOUT_MS);
  }

  const desiredIds = new Set(desired.map(({ secret }) => secret.id));
  const removed = [...new Set((before.secrets ?? []).map((item) => item.secret_id))]
    .filter((secretId) => !desiredIds.has(secretId));
  for (const secretId of removed) {
    await platinumJson(`/v1/secrets/${encodeURIComponent(secretId)}`, { method: 'DELETE' });
  }
  return { state: 'armed', attached: desired.length };
}
