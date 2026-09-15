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
// EXPECTED_PASSES=38
import { DatabaseSync } from "node:sqlite";
import { watchClaims } from "../../tools/crash-reporter.mjs";
let bad = 0;
const check = watchClaims((n, c, d = "") => { if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });
const { attachEnvironment, ensureUrl, usable, healthy, readCached, writeCached, clearCached, ENVIRONMENT_TABLE_SQL, ENSURE_POLL_MS, ENSURE_POLL_MAX_MS, pollDelay, ensureDelay, waitForRepo } = await import("../src/environment.js");

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
  // THE DAEMON BEING UP AND THE REPO BEING CLONED ARE TWO FACTS. Reporting one
  // number made every attach pay for the clone: measured 2026-09-12, Platinum
  // creates the box in 1.0 s and the daemon answers 0.2 s later, while the
  // clone takes another 3.4 s that `node --version` does not need.
  {
    const h = await healthy("https://edge", { fetch: async () => json({ daemon: "ok", repo_ready: false }) });
    check("a daemon that is up with NO checkout yet is healthy, and says the repo is not ready",
      h.ok === true && h.repoReady === false, JSON.stringify(h));
    const h2 = await healthy("https://edge", { fetch: async () => json({ daemon: "ok", repo_ready: true, branch: "b" }) });
    check("and once the checkout lands it says so, with the branch", h2.ok && h2.repoReady === true && h2.branch === "b", JSON.stringify(h2));
    const h3 = await healthy("https://edge", { fetch: async () => json({ daemon: "ok" }) });
    check("a daemon that reports no repo flag at all is treated as ready — an environment without a repo is not broken", h3.ok && h3.repoReady === true, JSON.stringify(h3));
  }
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
  // THIS CLAIM USED TO SAY "ASK OFTEN AT THE START", against a 2 s grid that
  // slept through a third of the attach. Asking often was the right correction
  // to that and the wrong shape for this: a Platinum create takes 1.2-2.0 s, so
  // the early asks cannot find anything, and the backoff they grow into then
  // leaves a gap where the box actually becomes ready. Measured on dev
  // 2026-09-15 — asks at 118/516/1063/1830 ms, active at 1959 ms, found at
  // 2904 ms. What matters is not how early it asks but how little it wastes
  // once the answer exists.
  check("the loop waits out the floor once rather than asking into it, then asks steadily",
    t === ensureDelay(0) + ensureDelay(1) && ensureDelay(1) < ensureDelay(0),
    `${t} ms of sleeping across two polls`);
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
  // Up, but the repo is not checked out yet: USABLE, and the attach says so.
  const sql = makeSql();
  const cp = controlPlane({ answers: [active], repoReady: false });
  let t = 0;
  const r = await attachEnvironment({ env: ENV, sql, fetch: cp.fetch, sleep: async (ms) => { t += ms; }, now: () => t });
  check("a machine whose daemon answers is ATTACHED even with no checkout yet — the clone is 3.4 s a `node -v` must not pay",
    r.ok === true && r.repoReady === false && readCached(sql)?.externalId === "sbx_1", JSON.stringify({ ok: r.ok, repo: r.repoReady }));
}
{
  // And the surfaces that DO need files wait for exactly that flag.
  let calls = 0;
  const f = async () => { calls++; return json({ daemon: "ok", repo_ready: calls >= 3, branch: "b1" }); };
  let t = 0;
  const w = await waitForRepo("https://edge", { fetch: f, sleep: async (ms) => { t += ms; }, now: () => t });
  check("waitForRepo polls until the checkout lands, and reports the branch and how long it waited",
    w.ok === true && w.branch === "b1" && calls === 3 && w.waitedMs === pollDelay(0) + pollDelay(1), JSON.stringify(w));
  let t2 = 0;
  const timedOut = await waitForRepo("https://edge", { fetch: async () => json({ daemon: "ok", repo_ready: false }), sleep: async (ms) => { t2 += ms; }, now: () => t2, maxMs: 2_000 });
  check("and it gives up with a reason rather than waiting forever", timedOut.ok === false && /did not finish/.test(timedOut.reason), JSON.stringify(timedOut));
  const gone = await waitForRepo("https://edge", { fetch: async () => { throw new Error("ECONNREFUSED"); }, sleep: async () => {}, now: () => 0, maxMs: 0 });
  check("a machine that stopped answering is a failure with its reason, not a hang", gone.ok === false && /ECONNREFUSED/.test(gone.reason), JSON.stringify(gone));
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


// ── the cadence itself ──
check("the poll backs off from a fast first ask toward the worker's own cadence, and never past it",
  pollDelay(0) === ENSURE_POLL_MS && pollDelay(1) > pollDelay(0) && pollDelay(20) === ENSURE_POLL_MAX_MS && pollDelay(0) < 500,
  `${pollDelay(0)}, ${pollDelay(1)}, ${pollDelay(5)}, ${pollDelay(20)}`);

// ── THE ASK CADENCE MATCHES WHAT IT WAITS FOR ──
{
  const { ensureDelay, ENSURE_FLOOR_MS, ENSURE_STEADY_MS, ENSURE_POLL_MAX_MS } = await import("../src/environment.js");
  const at = [];
  let t = 0;
  for (let i = 0; i < 12; i++) { at.push(t); t += ensureDelay(i); }
  check("the first wait clears the floor a provision cannot beat, instead of asking four times into an empty second",
    ensureDelay(0) === ENSURE_FLOOR_MS && ENSURE_FLOOR_MS >= 600, String(ensureDelay(0)));
  check("then it asks steadily, so the box is found within one steady step of going active",
    ensureDelay(1) === ENSURE_STEADY_MS && ensureDelay(5) === ENSURE_STEADY_MS, `${ensureDelay(1)}/${ensureDelay(5)}`);
  // 1.2-2.0 s is the measured provisioning range; every value in it must be
  // caught within a steady step, which is the claim the old backoff failed.
  const worst = Math.max(...[1200, 1500, 1800, 1959, 2000].map((ready) => {
    const found = at.find((x) => x >= ready);
    return found === undefined ? Infinity : found - ready;
  }));
  check("across the whole measured provisioning range the wasted wait is one step, not a second",
    worst <= ENSURE_STEADY_MS + 1, `worst overshoot ${worst}ms across ${JSON.stringify(at)}`);
  check("and a provision that drags on backs off rather than hammering the control plane for ever",
    ensureDelay(40) > ENSURE_STEADY_MS && ensureDelay(400) <= ENSURE_POLL_MAX_MS, `${ensureDelay(40)}/${ensureDelay(400)}`);
}

// ── THE EDGE IS WAITED FOR WITHOUT ASKING THE CONTROL PLANE AGAIN ──
//
// `ensure` answering with a preview url means the box EXISTS. Handling a miss
// by sleeping 300 ms and POSTing ensure a second time can only repeat what is
// already known, and each probe hung up to 2 s. Measured on dev 2026-09-15: the
// API provisioned in 1913 ms, the cell's ensure leg read 2957 ms, and the
// difference was this.
{
  const { waitForEdge, EDGE_POLL_MS, EDGE_POLL_MAX_MS } = await import("../src/environment.js");
  let calls = 0;
  const slept = [];
  const comesUpOnThirdTry = async () => {
    calls++;
    if (calls < 3) throw new Error("connection refused");
    return new Response(JSON.stringify({ repo_ready: false, branch: "b" }), { status: 200 });
  };
  const r = await waitForEdge("https://edge.example", {
    fetch: comesUpOnThirdTry,
    sleep: async (ms) => { slept.push(ms); },
    now: (() => { let t = 0; return () => (t += 10); })(),
  });
  check("a box whose edge is not up yet is probed again, and answers without a second ensure",
    r.ok === true && calls === 3, JSON.stringify({ ok: r.ok, calls }));
  check("and the first retry is tens of milliseconds, not the control plane's own cadence",
    slept[0] === EDGE_POLL_MS && slept.every((ms) => ms <= EDGE_POLL_MAX_MS), JSON.stringify(slept));
  check("the repo's readiness rides back with it, so the caller still decides whether to wait for the clone",
    r.repoReady === false && r.branch === "b", JSON.stringify({ repoReady: r.repoReady, branch: r.branch }));
  const dead = await waitForEdge("https://edge.example", {
    fetch: async () => { throw new Error("nope"); },
    sleep: async () => {},
    now: (() => { let t = 0; return () => (t += 400); })(),
    maxMs: 1_000,
  });
  check("an edge that never comes up gives up within its budget and says why, rather than hanging",
    dead.ok === false && /nope/.test(dead.reason) && dead.waitedMs <= 2_000, JSON.stringify(dead));
}

console.log(bad ? `\n${bad} FAILED` : "\nall claims hold");
process.exit(bad ? 1 : 0);
