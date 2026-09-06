// THE KORTIX SESSION SURFACE, ON A CELL.
//
// A Kortix session drives a worker over a fixed set of paths — /kortix/health,
// /kortix/env, /kortix/refresh, /interrupt, /turn, /session (see
// apps/kortix-worker/src/main.ts). A cell does every one of those things under
// its own names, so parity is a mapping; these claims are what make the mapping
// a contract rather than a coincidence. Without them a rename in either project
// silently un-drives every session on a cell.
//
// In-process against the real bundle, like cell-logic.mjs: no Docker, no celld.
// Read by test/all.sh.
// EXPECTED_PASSES=17
import { makeCell, installWorkerGlobals } from "./cell-harness.mjs";
import { watchClaims } from "../../tools/crash-reporter.mjs";
installWorkerGlobals();
const mod = await import("../dist/worker.js");
const AgentCell = mod.AgentCell ?? mod.default?.AgentCell;
if (!AgentCell) { console.log("  FAIL  dist/worker.js does not export AgentCell — run `npm run build`"); process.exit(1); }
let bad = 0;
const check = watchClaims((name, cond, detail = "") => {
  if (cond) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); bad++; }
});
const ENV = { SCRIPT: "[]", TOOL_DAEMON_URL: "http://127.0.0.1:9", TOOL_DAEMON_TOKEN: "t" };

{
  const h = makeCell(AgentCell, ENV);

  // Readiness is what a session polls before it sends anything. A cell is ready
  // the moment it can answer — there is no daemon to wait for, which is the
  // whole point of the worker path.
  const health = await (await h.fetch("/kortix/health?c=s")).json();
  check("GET /kortix/health answers ready, for this session", health.ok === true && health.sessionId === "s", JSON.stringify(health));

  // THE FIELDS KORTIX ACTUALLY CLASSIFIES THE BOX FROM.
  //
  // classifyDaemonHealth (apps/api/src/projects/lib/legacy-runtime-bootstrap.ts)
  // reads `daemon` and `runtime` and nothing else to decide what this box is:
  // `daemon !== "ok"` is not-ok, and a `runtime` that is not an OBJECT is a
  // pre-convergence box put through a path a cell has no use for. This answered
  // `{ok: true, runtime: "ready"}` — every word true, none of it read.
  //
  // Measured on dev 2026-09-06, session 708ea3ca: the cell answered 200 on
  // /kortix/health throughout while the session sat in `open-session:starting`
  // for 181 s and never opened.
  check("health says daemon:'ok' — anything else classifies the box as not-ok",
    health.daemon === "ok", JSON.stringify(health.daemon));
  check("and `runtime` is an OBJECT — a string classifies the box as legacy",
    health.runtime !== null && typeof health.runtime === "object" && !Array.isArray(health.runtime),
    `runtime=${JSON.stringify(health.runtime)}`);
  check("and it does not make the session wait for an OpenCode a cell never runs",
    health.opencode === "ok" && health.opencode_session_required === false && health.repo_required === false,
    JSON.stringify({ opencode: health.opencode, req: health.opencode_session_required, repo: health.repo_required }));
  check("and it declares itself ready and healthy in the session's own words",
    health.runtimeReady === true && health.status === "ok" && health.engine === "pi",
    JSON.stringify({ runtimeReady: health.runtimeReady, status: health.status, engine: health.engine }));
  check("…and says whether a turn is running", health.busy === false, JSON.stringify(health));

  // Env sync: the session pushes the environment a turn runs with.
  const put = await (await h.fetch("/kortix/env?c=s", { method: "POST", body: JSON.stringify({ env: { KORTIX_TOKEN: "t1", MODEL_NAME: "m" } }) })).json();
  check("POST /kortix/env applies the keys it was given", put.ok === true && put.applied === 2, JSON.stringify(put));
  const got = await (await h.fetch("/kortix/env?c=s")).json();
  check("GET /kortix/env reads them back", got.keys.includes("KORTIX_TOKEN") && got.keys.includes("MODEL_NAME"), JSON.stringify(got));

  // A key that is not a shell identifier is dropped rather than stored: a name
  // like `PATH=x; rm -rf /` has no business reaching an environment.
  const bad1 = await (await h.fetch("/kortix/env?c=s", { method: "POST", body: JSON.stringify({ env: { "no spaces": "1", "1leading": "2", OK_NAME: "3" } }) })).json();
  check("POST /kortix/env refuses names that are not identifiers", bad1.applied === 1 && bad1.keys[0] === "OK_NAME", JSON.stringify(bad1));

  // A bare map (no `env` wrapper) is what some callers send; both shapes work.
  const bare = await (await h.fetch("/kortix/env?c=s", { method: "POST", body: JSON.stringify({ PLAIN: "1" }) })).json();
  check("POST /kortix/env takes a bare map too", bare.applied === 1 && bare.keys[0] === "PLAIN", JSON.stringify(bare));

  // Refresh re-reads what a cell can re-read: its skills.
  const refresh = await (await h.fetch("/kortix/refresh?c=s", { method: "POST" })).json();
  check("POST /kortix/refresh re-reads skills and reports how many", refresh.ok === true && typeof refresh.skills === "number", JSON.stringify(refresh));

  // Turn + session documents.
  const turn = await (await h.fetch("/turn?c=s")).json();
  check("GET /turn is idle before anything runs", turn.running === false && turn.status === "idle", JSON.stringify(turn));
  const sess = await (await h.fetch("/session?c=s")).json();
  check("GET /session describes the session, not a turn", sess.sessionId === "s" && sess.messages === 0 && sess.busy === false, JSON.stringify(sess));

  // Interrupt with nothing running is an answer, not an error — a session may
  // stop a turn that has already finished.
  const stop = await (await h.fetch("/interrupt?c=s", { method: "POST" })).json();
  check("POST /interrupt with no turn says so rather than failing", stop.stopped === false && /no turn/.test(stop.reason), JSON.stringify(stop));

  // The session surface must not disturb the cell's own: /health and / still
  // answer exactly as before, because celld and the agent's own tests use them.
  const own = await (await h.fetch("/?c=s")).json();
  check("the cell's own root still answers", own.ok === true && own.sessionId === "s", JSON.stringify(own));
}
{
  // Worker-level readiness: a session polls BEFORE it has a session to name, so
  // the default export answers it without touching a cell.
  const worker = mod.default;
  const r = await worker.fetch(new Request("http://cell/kortix/health"), { AGENT: null });
  const body = await r.json();
  check("the worker answers /kortix/health with no session named", r.status === 200 && body.ok === true, JSON.stringify(body));
  // The session polls readiness BEFORE it has a session to name, so this body
  // has to classify too — an unclassifiable one leaves it waiting exactly as
  // long as an unreachable box would.
  check("and that answer classifies the same way as the in-cell one",
    body.daemon === "ok" && typeof body.runtime === "object" && body.runtime !== null && body.runtimeReady === true,
    JSON.stringify(body));
}
process.exit(bad ? 1 : 0);
