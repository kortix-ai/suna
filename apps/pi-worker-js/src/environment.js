// THE SESSION'S ENVIRONMENT — A FULL LINUX MACHINE, ON DEMAND.
//
// Kortix already splits a pi session in two: a WORKER that thinks (on
// pi.kortix.com, apps/kortix-worker in a microVM; here, this cell) and an
// ENVIRONMENT that acts — a second box built from the project's own image,
// with node, pnpm, bun, python, the repo on the session branch and the
// daemon's RPC (apps/api platform/services/session-environment.ts). The
// production worker boots with NO environment and asks for one on its first
// tool call. A cell goes one step further: its own shell over its own tree
// covers the light work, and the environment is asked for only when the
// model says it needs a machine.
//
// Asking is one call the session's own token may make —
// `POST /v1/projects/:p/sessions/:s/environment/ensure` — which answers the
// CURRENT state and starts the provision out of band. So this polls: every
// two seconds until the row is active and carries both the edge address and
// the RPC secret, then once more against the box's own health until the repo
// is checked out. Measured on dev 2026-09-11: 10 s from the first ask to
// `active`, on a Platinum box from `kortix-default-880b7447621d`.
//
// What comes back is CACHED in the cell's SQLite: the environment outlives the
// isolate, and re-asking on every turn would cost a round trip for a box that
// has not changed. A resume (the row says stopped) or a rebuild (error) goes
// through the same ensure call, which is why a cached answer is re-validated
// against health before it is trusted again.

/** Poll cadence and bounds — the worker's own (kortix-worker lazy-env.ts). */
export const ENSURE_POLL_MS = 2_000;
export const ENSURE_MAX_MS = 180_000;

export const ENVIRONMENT_TABLE_SQL = "CREATE TABLE IF NOT EXISTS environment (k TEXT PRIMARY KEY, v TEXT NOT NULL)";

/** The ensure route for this session, from the env the control plane pushed. */
export function ensureUrl(env) {
  const api = String(env?.KORTIX_API_URL ?? "").replace(/\/+$/, "");
  const project = String(env?.KORTIX_PROJECT_ID ?? "").trim();
  const session = String(env?.KORTIX_SESSION_ID ?? "").trim();
  if (!api || !project || !session) return null;
  return `${api}/projects/${encodeURIComponent(project)}/sessions/${encodeURIComponent(session)}/environment/ensure`;
}

/**
 * Is this ensure answer a machine the cell can use RIGHT NOW? Active, with
 * somewhere to send RPCs and a secret to sign them with. A row that is
 * active but carries no edge yet (the preview lookup failed) is not usable,
 * and saying so keeps the poll going rather than handing the tools a URL of
 * null.
 */
export function usable(answer) {
  return !!(answer && answer.status === "active" && answer.external_id && answer.preview_url && answer.rpc_secret);
}

/** The cell's record of its machine. */
export function readCached(sql) {
  const rows = [...sql.exec("SELECT k, v FROM environment")];
  const m = Object.fromEntries(rows.map((r) => [r.k, r.v]));
  if (!m.external_id || !m.edge || !m.rpc_secret) return null;
  return { externalId: m.external_id, edge: m.edge, rpcSecret: m.rpc_secret, attachedAt: Number(m.attached_at ?? 0) };
}

export function writeCached(sql, { externalId, edge, rpcSecret, attachedAt = Date.now() }) {
  for (const [k, v] of [["external_id", externalId], ["edge", edge], ["rpc_secret", rpcSecret], ["attached_at", String(attachedAt)]]) {
    sql.exec("INSERT INTO environment(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
  }
}

export function clearCached(sql) {
  sql.exec("DELETE FROM environment");
}

/**
 * The box's own word that it is ready: the daemon answers `/kortix/health`
 * on the edge without auth, and `repo_ready` is what the worker waits on
 * before its first operation (lazy-env.ts).
 */
export async function healthy(edge, { fetch: f = globalThis.fetch, timeoutMs = 8_000 } = {}) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const res = await f(`${String(edge).replace(/\/+$/, "")}/kortix/health`, { signal: ac.signal });
    clearTimeout(t);
    if (!res.ok) return { ok: false, reason: `health ${res.status}` };
    const body = await res.json().catch(() => ({}));
    if (body?.repo_ready === false) return { ok: false, reason: "repo not ready" };
    return { ok: true, branch: body?.branch ?? null };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

/**
 * Get the session's environment: the cached one if it still answers, else
 * ask the control plane and wait for it.
 *
 * Returns `{ ok: true, externalId, edge, rpcSecret, resumed }` or
 * `{ ok: false, reason, status }` — never throws, because "there is no machine"
 * is an answer the tool has to give the model in words.
 */
export async function attachEnvironment({ env, sql, fetch: f = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, maxMs = ENSURE_MAX_MS, pollMs = ENSURE_POLL_MS, onProgress } = {}) {
  sql.exec(ENVIRONMENT_TABLE_SQL);
  const cached = readCached(sql);
  if (cached) {
    const h = await healthy(cached.edge, { fetch: f });
    if (h.ok) return { ok: true, ...cached, resumed: false };
    // The box is gone or asleep: the control plane's ensure knows how to
    // resume a stopped one and rebuild a removed one. Fall through.
    onProgress?.(`cached machine not answering (${h.reason}); asking again`);
  }
  const url = ensureUrl(env);
  if (!url) return { ok: false, reason: "this session has no control-plane address (KORTIX_API_URL / KORTIX_PROJECT_ID / KORTIX_SESSION_ID)", status: null };
  const token = String(env?.KORTIX_TOKEN ?? "");
  if (!token) return { ok: false, reason: "this session holds no token to ask with", status: null };
  const started = now();
  let last = null;
  while (now() - started < maxMs) {
    let res;
    try {
      res = await f(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
    } catch (e) {
      return { ok: false, reason: `control plane unreachable: ${String(e?.message ?? e)}`, status: null };
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, reason: `ensure answered ${res.status}: ${String(body?.error ?? "").slice(0, 200)}`, status: null };
    }
    last = body;
    onProgress?.(`environment ${body.status ?? "?"}`);
    if (body.status === "error") {
      return { ok: false, reason: "the control plane could not provision a machine for this session", status: "error" };
    }
    if (usable(body)) {
      const edge = String(body.preview_url).replace(/\/+$/, "");
      const h = await healthy(edge, { fetch: f });
      if (h.ok) {
        const record = { externalId: body.external_id, edge, rpcSecret: body.rpc_secret, attachedAt: now() };
        writeCached(sql, record);
        return { ok: true, ...record, resumed: !!cached };
      }
      onProgress?.(`machine up, ${h.reason}`);
    }
    await sleep(pollMs);
  }
  return { ok: false, reason: `the machine did not become ready within ${Math.round(maxMs / 1000)} s (last status: ${last?.status ?? "none"})`, status: last?.status ?? null };
}
