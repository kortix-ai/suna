import { pathToFileURL } from 'node:url';

// The api-router Worker's /internal gate engages only while the Worker carries
// the INTERNAL_EDGE_KEY secret, and the gateway + API engage theirs from the
// environment blob (KORTIX_INTERNAL_EDGE_KEY). Nothing kept those two in step:
// dev's Worker secret was set by hand, prod's never was, so the public API
// origin served its internal gateway control plane behind the static bearer
// alone (KRTX-2775). This script makes the env blob the one source of truth —
// the release sets the Worker secret when the blob names the key and deletes it
// when it does not — then proves the public origin's engagement state, so a
// drift fails loudly instead of silently downgrading the control plane's gate.
//
// Prod wiring (deploy-prod.yml): deploy-ecs rolls the API and the gateway, which
// both hydrate the key from the blob, then deploy-api-router reads the optional key with the aws-env action and runs:
//   node infra/scripts/sync-worker-edge-key.mjs
// with CLOUDFLARE_ACCOUNT_ID, WORKER_NAME and PUBLIC_API_ORIGIN in the env.

const SECRET_NAME = 'INTERNAL_EDGE_KEY';
const INTERNAL_PROBE_PATH = '/internal/gateway/models';
// The app's own floor (apps/api/src/llm-gateway/internal-auth.ts): a shorter
// token is filtered out and never matches, so engaging the edge gate with one
// would 404 the gateway's own calls. Refuse it at the write path instead.
const MIN_EDGE_KEY_LENGTH = 24;

function secretsPath(accountId, workerName) {
  return `/accounts/${accountId}/workers/scripts/${workerName}/secrets`;
}

async function cloudflare(path, options = {}) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required');
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) {
    throw new Error(`Cloudflare ${options.method || 'GET'} ${path.split('?')[0]} failed`);
  }
  return payload.result;
}

export function edgeSyncPlan(edgeKey) {
  const key = typeof edgeKey === 'string' ? edgeKey.trim() : '';
  if (!key) return { action: 'delete', engaged: false, edgeKey: '' };
  if (key.length < MIN_EDGE_KEY_LENGTH) {
    throw new Error(
      `the env blob's KORTIX_INTERNAL_EDGE_KEY is ${key.length} chars (want >= ${MIN_EDGE_KEY_LENGTH}) — the API refuses shorter keys at boot, so the edge gate could never match`,
    );
  }
  return { action: 'set', engaged: true, edgeKey: key };
}

async function listSecrets(accountId, workerName) {
  const result = await cloudflare(secretsPath(accountId, workerName));
  return new Set((result || []).map((secret) => secret.name));
}

export async function syncWorkerEdgeKey({ accountId, workerName, edgeKey }) {
  const plan = edgeSyncPlan(edgeKey);
  const path = secretsPath(accountId, workerName);
  const before = await listSecrets(accountId, workerName);

  if (plan.action === 'set') {
    await cloudflare(path, {
      method: 'PUT',
      body: JSON.stringify({ name: SECRET_NAME, text: plan.edgeKey, type: 'secret_text' }),
    });
  } else if (before.has(SECRET_NAME)) {
    await cloudflare(`${path}/${SECRET_NAME}`, { method: 'DELETE' });
  } else {
    return { action: 'noop', engaged: false };
  }

  const after = await listSecrets(accountId, workerName);
  const present = after.has(SECRET_NAME);
  if (present !== plan.engaged) {
    throw new Error(
      `Cloudflare did not persist the ${SECRET_NAME} ${plan.action} for ${workerName}`,
    );
  }
  return { action: plan.action === 'set' ? 'set' : 'deleted', engaged: plan.engaged };
}

// Prove the public origin's posture with two keyless-credential probes on the
// internal gateway control plane:
// - engaged: a bare POST must be 404 — the Worker (and the API's own edge
//   check) answer "not found" and the route never resolves;
// - engaged: the same POST with the blob's key in x-kortix-internal-edge-key
//   (and no bearer) must be 401 — the Worker passed the caller through and the
//   API's static-bearer gate answered. A 404 here means the Worker's secret
//   does NOT match the blob value the gateway sends: the sync persisted a
//   wrong or stale key.
// - unengaged: the bare POST must be 401 or 503 — the static bearer gate still
//   answers fail-closed. Anything else means the control plane changed its
//   public posture: fail loudly.
export async function verifyInternalEdgeEngagement({ origin, edgeKey }) {
  const bare = await probeInternalEdge(origin, {});
  if (edgeKey) {
    const matched = await probeInternalEdge(origin, { 'x-kortix-internal-edge-key': edgeKey });
    if (matched !== 401) {
      throw new Error(
        `${origin} did not accept the synced edge key on ${INTERNAL_PROBE_PATH} (got ${matched}, want 401) — ` +
          `the Worker's ${SECRET_NAME} does not match the env blob's KORTIX_INTERNAL_EDGE_KEY`,
      );
    }
  }
  if (edgeKey && bare === 404) return { bareStatus: bare, matchedStatus: 401, engaged: true };
  if (!edgeKey && (bare === 401 || bare === 503)) return { bareStatus: bare, engaged: false };
  const want = edgeKey ? '404' : '401 or 503';
  throw new Error(
    `internal gateway control plane on ${origin} answered ${bare} keyless (want ${want}) — ${
      edgeKey
        ? `the ${SECRET_NAME} edge gate is not engaged on the Worker or the origin`
        : 'the static bearer gate is not fail-closed'
    }`,
  );
}

async function probeInternalEdge(origin, headers) {
  const response = await fetch(`${origin}${INTERNAL_PROBE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: '{}',
    signal: AbortSignal.timeout(15000),
  });
  return response.status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const workerName = process.env.WORKER_NAME;
  const origin = process.env.PUBLIC_API_ORIGIN;
  if (!accountId || !workerName || !origin) {
    console.error('CLOUDFLARE_ACCOUNT_ID, WORKER_NAME and PUBLIC_API_ORIGIN are required');
    process.exit(1);
  }
  const sync = await syncWorkerEdgeKey({
    accountId,
    workerName,
    edgeKey: process.env.INTERNAL_EDGE_KEY,
  });
  const verify = await verifyInternalEdgeEngagement({
    origin,
    edgeKey: process.env.INTERNAL_EDGE_KEY,
  });
  process.stdout.write(`${JSON.stringify({ ...sync, probeStatus: verify.bareStatus })}\n`);
}
