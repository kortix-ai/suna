// ATTACHING THE SESSION'S ENVIRONMENT — the ask, the wait, the cache.
//
// The control plane's `ensure` answers the CURRENT state and starts the work
// out of band (apps/api platform/services/session-environment.ts), so the
// cell polls. These claims are about the poll and the record it leaves: a
// row that says `active` but carries no address yet must keep it polling; a
// box that is up but has not checked the repo out yet must keep it polling;
// `error` must stop it with the reason; a cached machine that still answers
// must be used without a round trip to the control plane, and one that does
// not must be re-asked for rather than trusted.
//
// Fake control plane, fake box, fake clock: every step is asserted without
// a Platinum account.
// EXPECTED_PASSES=24
import { DatabaseSync } from "node:sqlite";
import { watchClaims } from "../../tools/crash-reporter.mjs";
let bad = 0;
const check = watchClaims((n, c, d = "") => { if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });
const { attachEnvironment, ensureUrl, usable, healthy, readCached, writeCached, clearCached, ENVIRONMENT_TABLE_SQL, ENSURE_POLL_MS } = await import("../src/environment.js");

const makeSql = () => { const db = new DatabaseSync(":memory:"); return { exec(q, ...a) { const t = q.trim(); if (/^(CREATE|INSERT|UPDATE|DELETE)/i.test(t)) { const st = db.prepare(t); a.length ? st.run(...a) : st.run(); return { toArray: () => [], [Symbol.iterator]: function* () {} }; } const rows = db.prepare(t).all(...a); return { toArray: () => rows, [Symbol.iterator]: function* () { yield* rows; } }; } }; };
const ENV = { KORTIX_API_URL: "https://api.example/v1", KORTIX_PROJECT_ID: "p1", KORTIX_SESSION_ID: "s1", KORTIX_TOKEN: "tok" };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

// ── the address ──
check("the ensure route is the session's own, under the API the control plane pushed",
  ensureUrl(ENV) === "https://api.example/v1/projects/p1/sessions/s1/environment/ensure", ensureUrl(ENV));
check("and a session that lacks any of the three has no address, not a half-formed one",
  ensureUrl({ ...ENV, KORTIX_PROJECT_ID: "" }) === null && ensureUrl({}) === null, "");

// ── what counts as usable ──
check("an answer is usable only when active WITH an address AND a secret",
  usable({ status: "active", external_id: "x", preview_url: "https://e", rpc_secret: "s" })
    && !usable({ status: "active", external_id: "x", preview_url: null, rpc_secret: "s" })
    && !usable({ status: "active", external_id: "x", preview_url: "https://e", rpc_secret: null })
    && !usable({ status: "provisioning", external_id: null, preview_url: null, rpc_secret: null }) && !usable(null), "");

// ── the cache ──
{
  const sql = makeSql(); sql.exec(ENVIRONMENT_TABLE_SQL);
  check("an empty cache is null, not a record of nothing", readCached(sql) === null, "");
  writeCached(sql, { externalId: "sbx_a", edge: "https://8000-a.sbx", rpcSecret: "sec", attachedAt: 5 });
  const r = readCached(sql);
  check("a written record reads back whole", r.externalId === "sbx_a" && r.edge === "https://8000-a.sbx" && r.rpcSecret === "sec" && r.attachedAt === 5, JSON.stringify(r));
  writeCached(sql, { externalId: "sbx_b", edge: "https://b", rpcSecret: "s2" });
  check("and a second write replaces it — one machine per session", readCached(sql).externalId === "sbx_b", "");
  clearCached(sql);
  check("cleared is null again", readCached(sql) === null, "");
}

// ── health ──
{
  const f = async (u) => json({ daemon: "ok", repo_ready: true, branch: "s1" });
  const h = await healthy("https://edge/", { fetch: f });
  check("health asks the edge's /kortix/health and reads the branch", h.ok && h.branch === "s1", JSON.stringify(h));
  check("repo_ready=false is not healthy — the worker waits on exactly this flag",
    (await healthy("https://edge", { fetch: async () => json({ repo_ready: false }) })).ok === false, "");
  check("a non-200 is not healthy, with the status", /health 503/.test((await healthy("https://edge", { fetch: async () => json({}, 503) })).reason), "");
  check("an unreachable edge is not healthy, not a throw", (await healthy("https://edge", { fetch: async () => { throw new Error("ECONNREFUSED"); } })).ok === false, "");
}

// ── the attach, against a fake control plane and a fake box ──
function controlPlane(script) {
  let n = 0; const asks = [];
  return {
    asks,
    fetch: async (url, init) => {
      if (/\/kortix\/health$/.test(url)) return json({ daemon: "ok", repo_ready: script.repoReady ?? true, branch: "s1" });
      asks.push({ url, auth: init?.headers?.authorization });
      const step = script.answers[Math.min(n++, script.answers.length - 1)];
      return typeof step === "function" ? step() : json(step);
    },
  };
}
const active = { status: "active", external_id: "sbx_1", preview_url: "https://8000-1.sbx/", rpc_secret: "sec" };
const provisioning = { status: "provisioning", external_id: null, preview_url: null, rpc_secret: null };
{
  const sql = makeSql();
  const cp = controlPlane({ answers: [provisioning, provisioning, active] });
  let t = 0; const now = () => t; const sleep = async (ms) => { t += ms; };
  const progress = [];
  const r = await attachEnvironment({ env: ENV, sql, fetch: cp.fetch, sleep, now, onProgress: (l) => progress.push(l) });
  check("the attach POSTs ensure with the session's token and polls until the machine is usable",
    r.ok && r.externalId === "sbx_1" && r.edge === "https://8000-1.sbx" && r.rpcSecret === "sec" && cp.asks.length === 3 && cp.asks[0].auth === "Bearer tok",
    JSON.stringify({ r: { ok: r.ok, id: r.externalId }, asks: cp.asks.length }));
  check("at the worker's own cadence", t === 2 * ENSURE_POLL_MS, String(t));
  check("and reports each state it saw, so the tool can tell the user what it waited on", progress.some((p) => /provisioning/.test(p)) && progress.some((p) => /active/.test(p)), JSON.stringify(progress));
  check("the record is cached for the next turn", readCached(sql)?.externalId === "sbx_1", "");
  const again = await attachEnvironment({ env: ENV, sql, fetch: cp.fetch, sleep, now });
  check("a second attach uses the cache: one health probe, NO ensure call", again.ok && again.resumed === false && cp.asks.length === 3, String(cp.asks.length));
}
{
  // A row that is active but has no address yet keeps the poll going — the
  // control plane's edge lookup can lag the state by a beat.
  const sql = makeSql();
  const cp = controlPlane({ answers: [{ ...active, preview_url: null }, active] });
  let t = 0;
  const r = await attachEnvironment({ env: ENV, sql, fetch: cp.fetch, sleep: async (ms) => { t += ms; }, now: () => t });
  check("active-without-an-address is not usable yet: it polls once more and takes the address when it comes", r.ok && cp.asks.length === 2, String(cp.asks.length));
}
{
  // Up, but the repo is not checked out yet: not ready.
  const sql = makeSql();
  const cp = controlPlane({ answers: [active], repoReady: false });
  let t = 0;
  const r = await attachEnvironment({ env: ENV, sql, fetch: cp.fetch, sleep: async (ms) => { t += ms; }, now: () => t, maxMs: 3 * ENSURE_POLL_MS });
  check("a machine that is up but has not checked the repo out is waited on, and given up on with the last status named",
    r.ok === false && /did not become ready/.test(r.reason) && /active/.test(r.reason) && readCached(sql) === null, r.reason);
}
{
  const sql = makeSql();
  const cp = controlPlane({ answers: [provisioning, { status: "error", external_id: null, preview_url: null, rpc_secret: null }] });
  let t = 0;
  const r = await attachEnvironment({ env: ENV, sql, fetch: cp.fetch, sleep: async (ms) => { t += ms; }, now: () => t });
  check("`error` stops the poll with a reason the model can repeat", r.ok === false && r.status === "error" && /could not provision/.test(r.reason), r.reason);
}
{
  const sql = makeSql();
  const cp = controlPlane({ answers: [() => json({ error: "Forbidden" }, 403)] });
  const r = await attachEnvironment({ env: ENV, sql, fetch: cp.fetch, sleep: async () => {}, now: () => 0 });
  check("a refused ensure is reported with the status and the message — never retried", r.ok === false && /403/.test(r.reason) && /Forbidden/.test(r.reason) && cp.asks.length === 1, r.reason);
  const off = await attachEnvironment({ env: ENV, sql, fetch: async (u) => { throw new Error("ENOTFOUND api.example"); }, sleep: async () => {}, now: () => 0 });
  check("an unreachable control plane is said in words", off.ok === false && /unreachable/.test(off.reason), off.reason);
  check("a session with no token cannot ask, and says so", (await attachEnvironment({ env: { ...ENV, KORTIX_TOKEN: "" }, sql, fetch: cp.fetch })).reason.includes("no token"), "");
  check("a session with no address cannot ask, and says so", (await attachEnvironment({ env: {}, sql, fetch: cp.fetch })).reason.includes("control-plane address"), "");
}
{
  // The cached machine went away (stopped, reaped): re-ask, which the
  // control plane answers by resuming or rebuilding; the record is replaced.
  const sql = makeSql(); sql.exec(ENVIRONMENT_TABLE_SQL);
  writeCached(sql, { externalId: "sbx_old", edge: "https://8000-old.sbx", rpcSecret: "s0" });
  let healthCalls = 0;
  const f = async (url, init) => {
    if (/8000-old\.sbx\/kortix\/health$/.test(url)) { healthCalls++; return json({}, 502); }
    if (/\/kortix\/health$/.test(url)) return json({ repo_ready: true });
    return json({ ...active, external_id: "sbx_new", preview_url: "https://8000-new.sbx" });
  };
  const r = await attachEnvironment({ env: ENV, sql, fetch: f, sleep: async () => {}, now: () => 0 });
  check("a cached machine that no longer answers is re-asked for, and the new one replaces it",
    r.ok && r.externalId === "sbx_new" && r.resumed === true && healthCalls === 1 && readCached(sql).externalId === "sbx_new", JSON.stringify({ id: r.externalId, resumed: r.resumed }));
}

console.log(bad ? `\n${bad} FAILED` : "\nall claims hold");
process.exit(bad ? 1 : 0);
