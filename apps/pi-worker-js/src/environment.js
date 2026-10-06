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

/**
 * POLL CADENCE. The production worker asks every 2 s, which is right for a
 * process with nothing else to do and wrong for a person waiting. A 2 s grid
 * quantises a 1.5 s provision into a 2 s one. Measured on dev 2026-09-12: of a
 * 6.2 s attach — 2.6 s to a running microVM, 3.4 s more for its repo clone —
 * up to 2 s was this loop asleep rather than the box booting.
 *
 * So: ask often at the start, when the answer has most likely just arrived,
 * and back off toward the worker's cadence for the long tail of a cold pull.
 */
export const ENSURE_POLL_MS = 300;
export const ENSURE_POLL_MAX_MS = 2_000;
export const ENSURE_MAX_MS = 180_000;

/**
 * THE ASK CADENCE, SHAPED LIKE THE THING IT IS WAITING FOR.
 *
 * Provisioning is not an event with an unknown distribution: it is a Platinum
 * create, and it takes 1.2-2.0 s every time. An exponential backoff is the
 * wrong shape for that — it asks four times while nothing can possibly be ready
 * and then leaves a gap exactly where it becomes ready.
 *
 * Measured on dev 2026-09-15, one attach, marks from the loop itself:
 *
 *   provisioning=118ms  516ms  1063ms  1830ms   active=2904ms
 *
 * The control plane's own log put the box active at 1959 ms. The 945 ms
 * between that and the fifth ask was the whole overhead.
 *
 * So: ask once to start it, wait out the floor, then ask steadily. The first
 * gap is the one place a long wait is free, and 150 ms steady is cheap — the
 * answer is a row read. After a few seconds it backs off, because a
 * provisioning that has not finished by then is not one more poll away.
 */
export const ENSURE_FLOOR_MS = 900;
export const ENSURE_STEADY_MS = 150;
export const ENSURE_STEADY_ASKS = 20;
export const ensureDelay = (attempt) =>
  attempt === 0 ? ENSURE_FLOOR_MS
    : attempt < ENSURE_STEADY_ASKS ? ENSURE_STEADY_MS
      : pollDelay(attempt - ENSURE_STEADY_ASKS, ENSURE_STEADY_MS * 2, ENSURE_POLL_MAX_MS);

/** The nth wait, backing off from `ENSURE_POLL_MS` toward the ceiling. */
export const pollDelay = (attempt, base = ENSURE_POLL_MS, ceiling = ENSURE_POLL_MAX_MS) =>
  Math.min(Math.round(base * 1.4 ** Math.max(0, attempt)), ceiling);

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
  return { externalId: m.external_id, edge: m.edge, rpcSecret: m.rpc_secret, attachedAt: Number(m.attached_at ?? 0), branch: m.branch || null };
}

export function writeCached(sql, { externalId, edge, rpcSecret, attachedAt = Date.now(), branch = null }) {
  for (const [k, v] of [["external_id", externalId], ["edge", edge], ["rpc_secret", rpcSecret], ["attached_at", String(attachedAt)], ["branch", branch ?? ""]]) {
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
export async function healthy(edge, { fetch: f = globalThis.fetch, timeoutMs = 2_000 } = {}) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const res = await f(`${String(edge).replace(/\/+$/, "")}/kortix/health`, { signal: ac.signal });
    clearTimeout(t);
    if (!res.ok) return { ok: false, reason: `health ${res.status}` };
    const body = await res.json().catch(() => ({}));
    // THE DAEMON BEING UP AND THE REPO BEING CLONED ARE TWO DIFFERENT FACTS,
    // and conflating them cost every attach the whole clone.
    //
    // Measured 2026-09-12: Platinum creates the microVM in 1.0 s (three raw
    // creates of this template: 1216, 1047, 1007 ms). The daemon answers
    // ~0.2 s later. The repo clone then takes another 3.4 s — more than the
    // box itself — and `node --version`, the first thing most sessions run,
    // needs none of it. So readiness is reported in two parts and the caller
    // decides which one it is waiting for.
    return { ok: true, repoReady: body?.repo_ready !== false, branch: body?.branch ?? null };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

/**
 * WAIT FOR THE EDGE, NOT FOR THE CONTROL PLANE TO SAY THE SAME THING AGAIN.
 *
 * Once `ensure` has answered with a preview url the box EXISTS; the only thing
 * still pending is its edge answering. The loop used to handle that miss by
 * sleeping 300 ms and POSTing `ensure` a second time — a full control-plane
 * round trip that can only repeat what is already known — and each probe spent
 * up to 2 s failing.
 *
 * Measured on dev 2026-09-15, one session end to end: the API provisioned in
 * 1913 ms and the cell's `ensure` leg read 2957 ms. That 1044 ms was this.
 *
 * A box that is up answers in about 100 ms, so the probes start 40 ms apart and
 * back off gently, and each one gives up quickly rather than hanging.
 */
export const EDGE_PROBE_MS = 750;
export const EDGE_POLL_MS = 40;
export const EDGE_POLL_MAX_MS = 400;
export async function waitForEdge(edge, { fetch: f = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, maxMs = 20_000, probeMs = EDGE_PROBE_MS } = {}) {
  const started = now();
  let attempt = 0;
  let last = { ok: false, reason: "not probed" };
  while (now() - started < maxMs) {
    last = await healthy(edge, { fetch: f, timeoutMs: probeMs });
    if (last.ok) return { ...last, waitedMs: now() - started };
    await sleep(pollDelay(attempt++, EDGE_POLL_MS, EDGE_POLL_MAX_MS));
  }
  return { ...last, waitedMs: now() - started };
}

/**
 * Wait for the machine's checkout, for the operations that need it: the file
 * routes, git, and anything reading the project. A command like `node -v` does
 * not call this and does not pay for it.
 */
export async function waitForRepo(edge, { fetch: f = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, maxMs = 60_000 } = {}) {
  const started = now();
  let attempt = 0;
  for (;;) {
    const h = await healthy(edge, { fetch: f });
    if (h.ok && h.repoReady) return { ok: true, branch: h.branch ?? null, waitedMs: now() - started };
    if (now() - started >= maxMs) return { ok: false, reason: h.ok ? "the machine's checkout did not finish" : h.reason, waitedMs: now() - started };
    await sleep(pollDelay(attempt++));
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
export async function attachEnvironment({ env, sql, fetch: f = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, maxMs = ENSURE_MAX_MS, pollMs = null, onProgress } = {}) {
  sql.exec(ENVIRONMENT_TABLE_SQL);
  const cached = readCached(sql);
  if (cached) {
    const h = await healthy(cached.edge, { fetch: f });
    if (h.ok) return { ok: true, ...cached, branch: h.branch ?? cached.branch, repoReady: !!h.repoReady, resumed: false };
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
  let attempt = 0;
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
      // A SHORT PROBE, RETRIED, NOT ONE LONG HANG. The edge for a box that
      // was exposed a moment ago does not answer instantly, and an 8 s
      // timeout spends all 8 on the first miss. Measured 2026-09-12: the
      // attach's `ensure` leg read 12.6 s against a 6.2 s control-plane
      // floor, and this was where the difference lived.
      const h = await waitForEdge(edge, { fetch: f, sleep, now, maxMs: Math.max(1_000, maxMs - (now() - started)) });
      if (h.ok) {
        const record = { externalId: body.external_id, edge, rpcSecret: body.rpc_secret, attachedAt: now(), branch: h.branch ?? null };
        writeCached(sql, record);
        return { ok: true, ...record, repoReady: !!h.repoReady, resumed: !!cached };
      }
      onProgress?.(`machine up, ${h.reason}`);
    }
    await sleep(pollMs ?? ensureDelay(attempt++));
  }
  return { ok: false, reason: `the machine did not become ready within ${Math.round(maxMs / 1000)} s (last status: ${last?.status ?? "none"})`, status: last?.status ?? null };
}
