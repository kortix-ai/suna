// DO THE PLATINUM TOOLS SEND WHAT THE ROUTES ACTUALLY ACCEPT?
//
// The stub answers that end to end, but it needs Docker, MinIO and a cell — and
// when any of those is unavailable the most important question goes unasked. It
// does not need any of them: the tools build a request, and the route's zod
// schema is a fact in the repo. So this stubs `fetch`, drives each tool once,
// and asserts the exact method, URL and body against
// apps/api/src/api/sandboxes.ts.
//
// The details it pins are the ones that are easy to get wrong and silent when
// wrong:
//
//   ExecBody = { cmd: string | string[],
//                timeout_ms: int 100..300000 default 30000 }
//
//   • timeout_ms is MILLISECONDS. A tool that passes seconds gives a 120 ms
//     budget to a two-minute command and every build "fails" instantly.
//   • the ceiling is 300000. Passing more is a 400 from zod, not a clamp.
//   • the floor is 100.
//   • /files takes `path` as a QUERY parameter, not a body field.
//
// Run: node test/platinum-shapes.mjs
// Read by test/all.sh. The suite's own tail line catches a section that ran
// and produced nothing; it cannot catch an exit partway through, which skips
// the tail entirely. This is the number that check compares against.
// EXPECTED_PASSES=30

import { readFileSync } from "node:fs";
import { platinumTools } from "../src/tools.platinum.js";
import { watchClaims } from "../../tools/crash-reporter.mjs";

// ── THE CONTRACT, READ FROM THE OTHER SIDE OF IT ────────────────────────────
//
// Everything below used to assert against the numbers in the comment above —
// a hand-written COPY of apps/api's schema. That copy cannot notice the
// original changing. Rename timeout_ms, move the ceiling, drop the floor, and
// all eighteen claims stay green while the agent breaks in production against
// the route it was supposed to match.
//
// So the schema is parsed out of apps/api/src/api/sandboxes.ts and the claims
// are made against THAT. The parse is deliberately strict: if the shape it
// expects is not found, every derived claim FAILS rather than skipping. A
// contract test that quietly stops testing when it cannot find the contract is
// the failure it exists to prevent.
import { havePlatinum, platinumPath } from "./platinum-repo.mjs";
if (!havePlatinum) { console.log("  SKIP: no Platinum checkout — this suite reads Platinum's source (set PLATINUM_REPO)"); process.exit(0); }
const API_SRC = platinumPath("apps/api/src/api/sandboxes.ts");

function execSchemaFromSource() {
  let src;
  try { src = readFileSync(API_SRC, "utf8"); }
  catch (e) { return { error: `cannot read ${API_SRC}: ${e.message}` }; }
  const block = /const ExecBody = z\.object\(\{([\s\S]*?)\n\}\);/.exec(src);
  if (!block) return { error: "ExecBody schema not found — it was renamed or restructured" };
  const body = block[1];
  const t = /timeout_ms:\s*z\.number\(\)\.int\(\)\.min\((\d+)\)\.max\((\d+)\)\.default\((\d+)\)/.exec(body);
  if (!t) return { error: "timeout_ms is no longer `int().min(N).max(N).default(N)`" };
  return {
    fields: [...body.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]),
    min: Number(t[1]), max: Number(t[2]), default: Number(t[3]),
    cmdUnion: /cmd:\s*z\.union\(\[z\.string\(\)/.test(body),
  };
}

const SCHEMA = execSchemaFromSource();

let failures = 0;
const check = watchClaims((name, cond, detail = "") => {
  if (cond) { console.log(`  ok    ${name}`); }
  else { console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); failures++; }
});

// A minimal stand-in for the cell's SQLite: the tools write their op ledger to
// it, and a shape test should still exercise that path rather than stub it out.
const ops = [];
// A small real store rather than a sink: the tools now READ the ledger before
// acting (an interrupted call must not be blindly repeated), so a mock that
// always returns nothing would make that guard untestable.
const opRows = new Map();
const sql = {
  exec: (q, ...args) => {
    ops.push({ q, args });
    if (/^SELECT status FROM ops/.test(q)) {
      const row = opRows.get(args[0]);
      return { toArray: () => (row ? [row] : []) };
    }
    if (/INSERT OR IGNORE INTO ops/.test(q) && !opRows.has(args[0])) {
      opRows.set(args[0], { status: "running" });
    }
    if (/UPDATE ops SET status/.test(q)) {
      const row = opRows.get(args[3]);
      if (row) row.status = args[0];
    }
    return { toArray: () => [] };
  },
};

const ENV = {
  PT_API_URL: "https://api-dev.platinum.dev/",   // trailing slash on purpose
  PT_SANDBOX_KEY: "pt_live_key_secret",
  PT_WORKSPACE_ID: "sbx_ws",
};

let seen = null;
globalThis.fetch = async (url, init) => {
  seen = { url: new URL(url), method: init?.method, headers: init?.headers, body: init?.body ? JSON.parse(init.body) : undefined };
  // Answer in the shape the real route does, so the tool's parsing is exercised.
  const p = seen.url.pathname;
  if (p.endsWith("/exec")) {
    return new Response(JSON.stringify({ result: { ok: true, stdout: "out", stderr: "", exit_code: 0 } }), { status: 200 });
  }
  if (p.endsWith("/files/list")) return new Response(JSON.stringify({ ok: true, entries: [{ name: "a", type: "file" }] }), { status: 200 });
  if (p.endsWith("/files/grep")) return new Response(JSON.stringify({ ok: true, matches: [{ path: "/a", line: 3, text: "hit" }] }), { status: 200 });
  return new Response("file-body", { status: 200 });
};

const tools = Object.fromEntries(platinumTools(ENV, "sess", sql).map((t) => [t.name, t]));

// ── bash ────────────────────────────────────────────────────────────────────
await tools.bash.execute("op1", { command: "echo hi", timeout: 90 });
check("bash posts to /v1/sandboxes/<id>/exec",
  seen.method === "POST" && seen.url.pathname === "/v1/sandboxes/sbx_ws/exec",
  `got ${seen.method} ${seen.url.pathname}`);
check("bash sends cmd as a string (the route wraps it as sh -c)",
  typeof seen.body.cmd === "string" && seen.body.cmd === "echo hi",
  JSON.stringify(seen.body));
check("bash converts seconds to timeout_ms",
  seen.body.timeout_ms === 90_000,
  `timeout_ms=${seen.body.timeout_ms} for timeout: 90 — sending seconds here gives a 90 ms budget`);
check("bearer token is sent, base URL slash normalised",
  seen.headers.authorization === "Bearer pt_live_key_secret" && !seen.url.pathname.includes("//"),
  seen.url.href);

await tools.bash.execute("op2", { command: "x", timeout: 99999 });
// Derived from the schema, not restated. A hardcoded 300000 here passed while
// the route's real ceiling had been changed to 120000 — verified by mutating
// apps/api and watching this suite stay green.
check(`timeout is clamped to the route's ${SCHEMA.error ? "?" : SCHEMA.max} ceiling`,
  !SCHEMA.error && seen.body.timeout_ms === SCHEMA.max,
  `timeout_ms=${seen.body.timeout_ms} would be a 400 from zod, not a clamp`);

await tools.bash.execute("op3", { command: "x", timeout: 0 });
check("timeout is clamped to the route's 100 floor",
  seen.body.timeout_ms === 100, `timeout_ms=${seen.body.timeout_ms}`);

await tools.bash.execute("op4", { command: "x" });
check("default timeout is within range when omitted",
  seen.body.timeout_ms >= 100 && seen.body.timeout_ms <= 300_000,
  `timeout_ms=${seen.body.timeout_ms}`);

// ── files ───────────────────────────────────────────────────────────────────
await tools.read.execute("op5", { path: "src/a.py", offset: 2, limit: 5 });
check("read GETs /files with path/offset/limit as QUERY parameters",
  seen.method === "GET" && seen.url.pathname === "/v1/sandboxes/sbx_ws/files" &&
  seen.url.searchParams.get("path") === "src/a.py" &&
  seen.url.searchParams.get("offset") === "2" && seen.url.searchParams.get("limit") === "5",
  seen.url.href);
check("read sends no body", seen.body === undefined);

await tools.write.execute("op6", { path: "src/b.py", content: "x" });
check("write PUTs /files with path in the query and content in the body",
  seen.method === "PUT" && seen.url.pathname === "/v1/sandboxes/sbx_ws/files" &&
  seen.url.searchParams.get("path") === "src/b.py" && seen.body.content === "x",
  seen.url.href);

await tools.list.execute("op7", {});
check("list defaults path to /",
  seen.url.pathname.endsWith("/files/list") && seen.url.searchParams.get("path") === "/",
  seen.url.href);

await tools.grep.execute("op8", { pattern: "TODO", max: 10 });
check("grep sends pattern and max",
  seen.url.pathname.endsWith("/files/grep") &&
  seen.url.searchParams.get("pattern") === "TODO" && seen.url.searchParams.get("max") === "10",
  seen.url.href);

// ── failure surfacing ───────────────────────────────────────────────────────
globalThis.fetch = async () =>
  new Response(JSON.stringify({ error: "forbidden: this API key is scoped to another sandbox", code: "sandbox_scope" }), { status: 403 });
let threw = null;
try { await tools.bash.execute("op9", { command: "x" }); } catch (e) { threw = e; }
check("a 403 surfaces the platform's own code, not a generic failure",
  threw && /403/.test(threw.message) && /sandbox_scope/.test(threw.message),
  threw ? threw.message : "did not throw");
check("a failed op is recorded in the ledger as error, not lost",
  ops.some((o) => /UPDATE ops SET status/.test(o.q) && o.args[0] === "error"),
  JSON.stringify(ops.slice(-1)));
check("every op recorded its intent BEFORE the call",
  ops.filter((o) => /INSERT OR IGNORE INTO ops/.test(o.q)).length === 9,
  `${ops.filter((o) => /INSERT OR IGNORE INTO ops/.test(o.q)).length} begins for 9 calls`);

// ── an interrupted call is not blindly repeated ─────────────────────────────
// Platinum's /exec takes no idempotency key, so nothing downstream can
// deduplicate. A cell that died mid-call and resumed must say the outcome is
// unknown rather than run the command again.
opRows.set("interrupted", { status: "running" });
let ran = false;
globalThis.fetch = async () => { ran = true; return new Response(JSON.stringify({ result: { ok: true } }), { status: 200 }); };
const out = await tools.bash.execute("interrupted", { command: "rm -rf build" });
check("an interrupted op is NOT re-executed", ran === false, "the command was sent again");
check("the model is told the outcome is unknown",
  out.details?.unknownOutcome === true && /may have completed/.test(out.content[0].text),
  JSON.stringify(out).slice(0, 120));
check("a FRESH op still executes normally",
  await (async () => { ran = false; await tools.bash.execute("fresh-op", { command: "true" }); return ran; })(),
  "a new call was blocked, which would break every retry");

// tools.platinum's ledger calls sql.exec(...).toArray(), so the double has to
// return something array-like rather than an array.
const fakeSql = { exec: () => ({ toArray: () => [] }) };

// ── a half-configured backend must refuse to exist ─────────────────────────
// Found by mutate-guards: removing this throw broke no claim. A backend built
// with a missing PT_* var would send every request to "undefined" and fail one
// tool call at a time, far from the misconfiguration — the constructor is where
// that has to stop.
{
  const cases = [
    ["nothing at all", {}],
    ["no key", { PT_API_URL: "http://x", PT_WORKSPACE_ID: "sbx_1" }],
    ["no workspace", { PT_API_URL: "http://x", PT_SANDBOX_KEY: "k" }],
    ["no url", { PT_SANDBOX_KEY: "k", PT_WORKSPACE_ID: "sbx_1" }],
  ];
  for (const [label, env] of cases) {
    let threw = null;
    try { platinumTools(env, "s", fakeSql); } catch (e) { threw = String(e?.message ?? e); }
    check(`a platinum backend with ${label} is refused at construction`,
      /needs PT_API_URL, PT_SANDBOX_KEY and PT_WORKSPACE_ID/.test(threw ?? ""), String(threw));
  }
  let ok = null;
  try { platinumTools({ PT_API_URL: "http://x", PT_SANDBOX_KEY: "k", PT_WORKSPACE_ID: "sbx_1" }, "s", fakeSql); }
  catch (e) { ok = String(e?.message ?? e); }
  check("and a fully configured one is not", ok === null, String(ok));
}

// ── a read the platform refuses ────────────────────────────────────────────
// Found by mutate-guards: this throw was unexecuted too. A 4xx on /files must
// surface — returning the error body as if it were the file's contents would
// hand the model an XML error document and call it source code.
{
  const saved = globalThis.fetch;
  globalThis.fetch = async () => new Response("<Error>denied</Error>", { status: 403 });
  const tools = platinumTools({ PT_API_URL: "http://x", PT_SANDBOX_KEY: "k", PT_WORKSPACE_ID: "sbx_1" }, "s", fakeSql);
  let out;
  try { out = await tools.find((t) => t.name === "read").execute("r_403", { path: "secret.txt" }, undefined, undefined, undefined); }
  catch (e) { out = { threw: String(e?.message ?? e) }; }
  globalThis.fetch = saved;
  check("a 403 on read THROWS rather than returning the error body as the file",
    /read secret\.txt -> 403/.test(out.threw ?? ""), JSON.stringify(out).slice(0, 140));
}

// ── the claims that are coupled to apps/api ────────────────────────────────
check("apps/api's ExecBody schema is readable and still has the shape this parses",
  !SCHEMA.error, SCHEMA.error ?? "");

if (!SCHEMA.error) {
  check("the route still takes `cmd` and `timeout_ms`, and nothing else",
    SCHEMA.fields.length === 2 && SCHEMA.fields.includes("cmd") && SCHEMA.fields.includes("timeout_ms"),
    JSON.stringify(SCHEMA.fields));
  check("`cmd` is still a string-or-array union, which is why the tools may send a string",
    SCHEMA.cmdUnion === true, String(SCHEMA.cmdUnion));
  // The numbers the tools clamp to must be the route's own, not a copy of them.
  const { platinumExecutionEnv } = await import("../src/execenv.platinum.js");
  let sent = null;
  globalThis.fetch = async (url, init) => {
    sent = { url: String(url), body: init?.body ? JSON.parse(init.body) : null };
    return new Response(JSON.stringify({ result: { ok: true, stdout: "", stderr: "", exit_code: 0 } }),
      { status: 200, headers: { "content-type": "application/json" } });
  };
  const env = platinumExecutionEnv({ apiUrl: "http://x", key: "k", sandboxId: "s", cwd: "/w" });
  await env.exec("true", { timeout: 999_999 });
  check("a timeout above the route's ceiling is clamped TO THE ROUTE'S CEILING, not to a copy of it",
    sent?.body?.timeout_ms === SCHEMA.max, `sent ${sent?.body?.timeout_ms}, schema max ${SCHEMA.max}`);
  await env.exec("true", { timeout: 0 });
  check("and a timeout below the route's floor is raised TO THE ROUTE'S FLOOR",
    sent?.body?.timeout_ms === SCHEMA.min, `sent ${sent?.body?.timeout_ms}, schema min ${SCHEMA.min}`);
  check("the field is named as the route names it",
    sent?.body && Object.prototype.hasOwnProperty.call(sent.body, "timeout_ms"),
    JSON.stringify(Object.keys(sent?.body ?? {})));
}

console.log(failures ? `\n  ${failures} shape mismatch(es)` : "\n  every request matches the route contract");
process.exit(failures ? 1 : 0);
