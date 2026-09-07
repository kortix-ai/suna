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
// EXPECTED_PASSES=41
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
  // A LIST, and a pinnable one. ensureOpencodeSessionPin GETs this and picks
  // the canonical root: the most recently active entry with NO parentID. An
  // object, or an entry with a parent, resolves to nothing and the session
  // reports runtime `booting` until it times out — measured on dev 2026-09-07,
  // session 6102257c, whose cell was healthy throughout.
  check("GET /session is a LIST, because the control plane pins a root from it",
    Array.isArray(sess) && sess.length === 1, JSON.stringify(sess).slice(0, 120));
  const root = Array.isArray(sess) ? sess[0] : {};
  check("its one entry is a ROOT — a parentID would make it unpickable",
    root.parentID === null && typeof root.id === "string" && root.id === "s", JSON.stringify(root).slice(0, 120));
  check("and it carries the times the resolver orders roots by",
    typeof root.time?.created === "number" && typeof root.time?.updated === "number", JSON.stringify(root.time));
  check("the cell's own document rides along, so nothing was lost",
    root.sessionId === "s" && root.messages === 0 && root.busy === false, JSON.stringify(root).slice(0, 140));

  // Interrupt with nothing running is an answer, not an error — a session may
  // stop a turn that has already finished.
  const stop = await (await h.fetch("/interrupt?c=s", { method: "POST" })).json();
  // THE DELIVERY ROUTE. Every composer send and queued prompt arrives at
  // POST /session/:rootId/prompt_async, not at this cell's /prompt. Before it
  // existed the request fell through to the generic handler, which answers 200
  // to any path — so the API believed the prompt was delivered and no turn ever
  // ran. Measured on dev 2026-09-07, session ef37beb7: ready in 7.1 s, prompt
  // 200, no assistant message ever.
  {
    const r = await h.fetch("/session/s/prompt_async?c=s", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "hello there" }] }),
    });
    check("POST /session/:root/prompt_async is ACCEPTED with 204, like OpenCode",
      r.status === 204, `status ${r.status}`);
    const turns = await (await h.fetch("/turn?c=s")).json();
    check("and it queued a turn rather than answering 200 and dropping it",
      turns.turn !== null || turns.status === "pending" || turns.status === "running", JSON.stringify(turns));
    const wrong = await h.fetch("/session/somebody-else/prompt_async?c=s", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "x" }] }),
    });
    check("a prompt addressed to ANOTHER root is refused, not run here",
      wrong.status === 404, `status ${wrong.status}`);
    const empty = await h.fetch("/session/s/prompt_async?c=s", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parts: [] }),
    });
    check("and a prompt with no text is a 400, not an empty turn",
      empty.status === 400, `status ${empty.status}`);
  }

  // THE TURN PROBE RELEASES THE NEXT PROMPT. A queued prompt is held while the
  // session holds turn authority, and the control plane settles that by reading
  // `turn_in_flight` from /kortix/health?turn=1. A body without the field never
  // clears the marker, so every prompt after the first waits for ever on
  // `turn_active` — measured on dev 2026-09-07, session dee5338a: accepted 202,
  // state `waiting`, attempts 0, no delivery ever attempted.
  {
    // A FRESH cell: an earlier claim in this file queues a prompt, and a probe
    // taken after it would read `in flight` for a reason that has nothing to do
    // with what is being claimed here.
    const hp = makeCell(AgentCell, ENV);
    const idle = await (await hp.fetch("/kortix/health?c=s&turn=1")).json();
    check("health?turn=1 answers turn_in_flight, which is what settles a turn",
      idle.turn_in_flight === false, JSON.stringify({ f: idle.turn_in_flight }));
    check("and names how the last turn ended, so the settle has a reason",
      idle.turn_end === "completed" || idle.turn_end === "error", JSON.stringify(idle.turn_end));
    check("a plain health call does NOT carry the probe — it is asked for",
      (await (await hp.fetch("/kortix/health?c=s")).json()).turn_in_flight === undefined, "turn fields leaked into plain health");

    await hp.fetch("/session/s/prompt_async?c=s", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "queued work" }] }),
    });
    const busy = await (await hp.fetch("/kortix/health?c=s&turn=1")).json();
    check("a QUEUED prompt reads as in flight — the next one must wait behind it",
      busy.turn_in_flight === true, JSON.stringify({ f: busy.turn_in_flight }));
    check("and an accepted prompt that has not run yet is reported as orphaned",
      busy.turn_orphaned_prompt === true, JSON.stringify(busy.turn_orphaned_prompt));
  }

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
  // THE PROXY CARRIES NO `?c=`. A Kortix session reaches this worker through
  // the API's sandbox proxy, which forwards the path and not the query, so
  // every request the product makes arrives unnamed. Defaulting to "default"
  // put them all on an isolate that is nobody's session — measured on dev
  // 2026-09-07, session 16310084: GET /session answered 200 through the proxy
  // while the delivery POST to /session/<session>/prompt_async 404'd on both
  // ports, because it was asking the wrong cell.
  {
    const envd = { ...ENV, KORTIX_SESSION_ID: "sess-42" };
    const hd = makeCell(AgentCell, envd);
    const unnamed = await (await hd.fetch("/session")).json();
    check("with no ?c=, the cell answers as the session its ENV names",
      Array.isArray(unnamed) && unnamed[0]?.id === "sess-42", JSON.stringify(unnamed).slice(0, 120));
    const deliver = await hd.fetch("/session/sess-42/prompt_async", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "through the proxy" }] }),
    });
    check("so a delivery addressed to that session is ACCEPTED, not 404'd",
      deliver.status === 204, `status ${deliver.status}`);
    const named = await (await hd.fetch("/session?c=other")).json();
    check("and an explicit ?c= still names a different cell — the suites rely on it",
      named[0]?.id === "other", JSON.stringify(named).slice(0, 100));
  }

  // ONE CELL, MANY SESSIONS — addressed by the PATH. This is what takes the
  // per-session Platinum sandbox off the critical path: measured on dev
  // 2026-09-07 a cell sandbox costs 2443 ms before it can answer (POST 198 ms,
  // row running 1296 ms, expose 141 ms, edge live +928 ms), while another
  // isolate on a cell that already exists is 86-146 ms.
  {
    const shared = makeCell(AgentCell, { ...ENV, KORTIX_SESSION_ID: "owner" });
    const a = await (await shared.fetch("/session/alpha/prompt_async", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "for alpha" }] }),
    })).status;
    check("a prompt for a session named in the PATH is accepted, with no ?c=",
      a === 204, `status ${a}`);
    const b = await (await shared.fetch("/session/beta/prompt_async", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "for beta" }] }),
    })).status;
    check("and so is one for a DIFFERENT session on the same cell sandbox",
      b === 204, `status ${b}`);
    const unnamed = await (await shared.fetch("/session")).json();
    check("a request that names no session still falls back to the cell's own",
      unnamed[0]?.id === "owner", JSON.stringify(unnamed).slice(0, 100));
  }

  // THE PLATFORM'S NAMES FOR THE MODEL. The control plane injects
  // KORTIX_PROVIDER / KORTIX_TOKEN / KORTIX_MODEL / KORTIX_LLM_BASE_URL; a cell
  // reads MODEL_*. Nothing translated, so a real session arrived with a
  // gateway, a credential and a model, found no key, stayed scripted and
  // answered nothing — while every health field said it was fine. Measured on
  // dev 2026-09-07: sessions dee5338a and 5b482709 ran turns to `done` with no
  // model behind them.
  {
    // With the EMPTY wrangler defaults present, which is what a real cell has:
    // MODEL_PROVIDER and MODEL_BASE_URL are declared as "" so the bindings
    // exist for a scripted run. An empty string is not nullish, so `??` reads
    // it as a value and the platform's gateway is never reached. Measured on
    // dev 2026-09-07, session 3cd59929: all fourteen KORTIX_* names on the
    // isolate, gateway and token among them, and model_mode still "scripted".
    const gw = makeCell(AgentCell, {
      ...ENV, MODEL_PROVIDER: "", MODEL_BASE_URL: "", MODEL_API_KEY: "",
      KORTIX_LLM_BASE_URL: "https://gw.example/v1", KORTIX_TOKEN: "kt", KORTIX_MODEL: "glm-5.3-flash",
    });
    const live = await (await gw.fetch("/kortix/health?c=s")).json();
    check("a session given the platform's gateway and token runs LIVE, not scripted",
      live.model_mode === "live", `model_mode=${live.model_mode}`);

    // THE RULE THAT MATTERS MOST. KORTIX_TOKEN is a control-plane credential.
    // With no gateway to send it to there is no model key, and the cell stays
    // scripted rather than posting a session token to an external provider.
    const noGw = makeCell(AgentCell, { ...ENV, KORTIX_TOKEN: "kt", KORTIX_MODEL: "glm-5.3-flash" });
    const scripted = await (await noGw.fetch("/kortix/health?c=s")).json();
    check("but a token with NO gateway is not a model key — it is never sent to a provider",
      scripted.model_mode === "scripted", `model_mode=${scripted.model_mode}`);

    // An explicit pin still wins, so a bench or an operator is never overridden.
    const pinned = makeCell(AgentCell, {
      ...ENV, MODEL_PROVIDER: "anthropic", MODEL_API_KEY: "sk-x",
      KORTIX_LLM_BASE_URL: "https://gw.example/v1", KORTIX_TOKEN: "kt",
    });
    check("and an explicit MODEL_* pin beats the platform's names",
      (await (await pinned.fetch("/kortix/health?c=s")).json()).model_mode === "live", "explicit pin lost");
  }

  // THE SESSION'S ENVIRONMENT IS THE ONE PUSHED OVER HTTP, not the node's.
  //
  // A celld node hosts many cells and hands every CELLD_VAR_X on its process to
  // the worker as env.X, so anything set that way is identical for all of them.
  // A session's token, gateway, store URL and id cannot travel that way, and
  // the control plane does not try: it POSTs /kortix/env once the box is up.
  // This cell stored that and read the node's env anyway. Measured on dev
  // 2026-09-07, session ccaea567: the isolate's env held AGENT, MODEL_*,
  // SCRIPT, TOOL_DAEMON_URL and PT_S3_* and not one KORTIX_* name, while the
  // sandbox carried fourteen of them — so the session ran scripted, with no
  // token and no store.
  {
    const hs = makeCell(AgentCell, ENV);
    check("before any sync, the cell is scripted — the node's env has no session in it",
      (await (await hs.fetch("/kortix/health?c=s")).json()).model_mode === "scripted", "expected scripted");
    await hs.fetch("/kortix/env?c=s", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: { KORTIX_LLM_BASE_URL: "https://gw.example/v1", KORTIX_TOKEN: "kt", KORTIX_MODEL: "glm-5.3-flash" } }),
    });
    check("AFTER the sync it runs live — the pushed environment is the one that counts",
      (await (await hs.fetch("/kortix/health?c=s")).json()).model_mode === "live", "env sync did not reach the model");
    // And the node's values are still the defaults underneath, not erased.
    const model = await (await hs.fetch("/model?c=s")).json();
    check("the node's env survives underneath the session's",
      model.tools?.backend === "daemon", JSON.stringify(model.tools));
  }

  check("the worker answers /kortix/health with no session named", r.status === 200 && body.ok === true, JSON.stringify(body));
  // The session polls readiness BEFORE it has a session to name, so this body
  // has to classify too — an unclassifiable one leaves it waiting exactly as
  // long as an unreachable box would.
  check("and that answer classifies the same way as the in-cell one",
    body.daemon === "ok" && typeof body.runtime === "object" && body.runtime !== null && body.runtimeReady === true,
    JSON.stringify(body));
}
process.exit(bad ? 1 : 0);
