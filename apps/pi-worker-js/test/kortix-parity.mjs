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
// EXPECTED_PASSES=125
import { DatabaseSync } from "node:sqlite";
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
  // AND IT SURVIVES THE ISOLATE. Per-session config never arrives in the
  // cell's process env — that is the NODE's — so POST /kortix/env is the only
  // way a session is configured at all. Kept in memory it did not outlive an
  // eviction: measured on dev 2026-09-08, session 0d4f60b5 came back from a
  // destroyed box with no session env, so `toolsFor` no longer saw a platform
  // session, the cell backend was not chosen, and the agent asked to read its
  // own file wrote a different one instead.
  {
    const db = new DatabaseSync(":memory:");
    const first = makeCell(AgentCell, ENV, { db });
    await first.fetch("/kortix/env?c=s", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: { KORTIX_SESSION_ID: "sess-7", MODEL_BASE_URL: "https://gw.example/v1" } }),
    });
    // The eviction: same storage, new instance — exactly what celld does.
    const revived = makeCell(AgentCell, ENV, { db });
    const back = await (await revived.fetch("/kortix/env?c=s")).json();
    check("session env survives an eviction — it is in the cell's SQLite, not its memory",
      back.keys.includes("KORTIX_SESSION_ID") && back.keys.includes("MODEL_BASE_URL"),
      JSON.stringify(back.keys));
    const model = await (await revived.fetch("/model?c=s")).json();
    check("so the rebuilt cell still runs its tools on its own filesystem",
      model.tools?.backend === "cell" && model.tools?.cwd === "/work",
      JSON.stringify(model.tools));
  }

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

  // THE THREE ROUTES THE HARNESS SERVES AND A CELL DID NOT.
  //
  // /events is the one that decides how fast an answer FEELS. kortix-worker
  // streams every agent event as SSE and the product reads it; a cell had only
  // a WebSocket, so a consumer written against the harness saw nothing until
  // the turn was over. Measured against this gateway on dev 2026-09-07: first
  // content at 2.6-5.9 s, turn complete at 5.1-7.6 s — everything between is
  // time the user spends looking at nothing.
  // THE END OF A TURN IS TOLD TO THE CONTROL PLANE. The API opens a ledger
  // record when it delivers a prompt and admits the next inbox row only once
  // that record closes; kortix-worker closes it by POSTing `turn_end` to
  // /projects/:id/turn-stream. A cell that stayed silent left the record open
  // for its whole grant — measured on dev 2026-09-07, session b231c064: first
  // prompt answered in 9.0 s, second `waiting / turn_active` for 240 s while
  // the cell sat idle. Mutants this catches: dropping the relay, dropping the
  // wire id, relaying under the wrong path or without the bearer.
  // A SHARED CELL HOST MUST NOT MAKE EVERY SESSION REPORT THE SAME ONE.
  //
  // KORTIX_SESSION_ID is the NODE's env — one value for every cell on the box —
  // so preferring it made each cell relay turn_end under the session that
  // created the host. Measured on dev 2026-09-08: three sessions, one prompt
  // each, all relaying b673ad47-4365-4ab4-951d-0b592f9b9423, which the control
  // plane pinned as all three roots; all three then read ONE transcript, and a
  // brand-new session appeared to answer instantly because it was reading
  // somebody else's reply. The turn carries the session its prompt was
  // addressed to, and that is what the relay names.
  {
    const seen = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => { seen.push({ url: String(url), init }); return new Response("{}", { status: 200 }); };
    try {
      const shared = makeCell(AgentCell, {
        ...ENV, SCRIPT: JSON.stringify([{ text: "done" }]),
        KORTIX_API_URL: "https://api.example/v1", KORTIX_PROJECT_ID: "proj-1", KORTIX_TOKEN: "tok",
        // The node's env, naming the session that created the host.
        KORTIX_SESSION_ID: "host-creator",
      });
      await shared.fetch("/session/tenant-b/prompt_async?c=tenant-b", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: "hi" }] }),
      });
      await shared.drain();
      const relay = seen.find((x) => x.url.endsWith("/turn-stream"));
      const body = relay?.init?.body ? JSON.parse(relay.init.body) : {};
      check("turn_end names the session the PROMPT was for, not the node's KORTIX_SESSION_ID",
        body.session_id === "tenant-b" && body.opencode_session_id === "tenant-b",
        JSON.stringify({ got: body.session_id, node: "host-creator" }));
    } finally { globalThis.fetch = realFetch; }
  }

  {
    const seen = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => { seen.push({ url: String(url), init }); return new Response("{}", { status: 200 }); };
    try {
      const hr = makeCell(AgentCell, {
        ...ENV, SCRIPT: JSON.stringify([{ text: "done" }]),
        KORTIX_API_URL: "https://api.example/v1/", KORTIX_PROJECT_ID: "proj-1", KORTIX_TOKEN: "tok",
        KORTIX_SESSION_ID: "sess-9",
      });
      await hr.fetch("/session/s/prompt_async?c=s", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageID: "msg_wire1", parts: [{ type: "text", text: "hi" }] }),
      });
      await hr.drain();
      const relay = seen.find((x) => x.url.endsWith("/turn-stream"));
      check("when a turn ends the cell POSTs turn_end to /projects/:id/turn-stream — what closes the API's record",
        relay?.url === "https://api.example/v1/projects/proj-1/turn-stream" && relay?.init?.method === "POST",
        JSON.stringify(seen.map((x) => x.url)));
      const body = relay?.init?.body ? JSON.parse(relay.init.body) : {};
      // THE SESSION THE PROMPT WAS ADDRESSED TO. This claim used to expect
      // `KORTIX_SESSION_ID` here, which was right for one cell per box and
      // wrong the moment a box carried several: that variable is the NODE's, so
      // every cell reported the session that created the host. The prompt's own
      // path is the only thing that distinguishes them.
      check("with the prompt's session, the kind, an idle status and the wire id it carried",
        body.session_id === "s" && body.kind === "turn_end" && body.status === "idle"
          && body.opencode_session_id === "s" && body.turn_message_id === "msg_wire1",
        JSON.stringify(body));
      check("under the session's own bearer, as the daemon sends it",
        relay?.init?.headers?.authorization === "Bearer tok", JSON.stringify(relay?.init?.headers));

      seen.length = 0;
      const hq = makeCell(AgentCell, { ...ENV, SCRIPT: JSON.stringify([{ text: "done" }]) });
      await hq.fetch("/session/s/prompt_async?c=s", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: "hi" }] }),
      });
      await hq.drain();
      check("a cell with no control-plane identity tells nobody — a bench has no ledger",
        !seen.some((x) => x.url.endsWith("/turn-stream")), JSON.stringify(seen.map((x) => x.url)));
    } finally { globalThis.fetch = realFetch; }
  }


  // THE STREAM UNDER THE NAME THE PRODUCT ASKS FOR. The frontend subscribes to
  // `/global/event` (OpenCode's name, which the daemon serves); on a cell that
  // fell through to the generic handler, which answers 200 with JSON to any
  // path — so a subscriber got one `{"ok":true}` and then silence, with nothing
  // anywhere reporting a problem. Measured on dev 2026-09-09: /global/event
  // returned application/json while /events returned text/event-stream.
  {
    for (const path of ["/global/event", "/event", "/events"]) {
      const res = await h.fetch(`${path}?c=s`);
      check(`GET ${path} is an SSE stream, not a JSON 200`,
        res.headers.get("content-type")?.includes("text/event-stream") === true,
        `${path} -> ${res.headers.get("content-type")}`);
      await res.body.getReader().cancel();
    }
  }

  {
    const res = await h.fetch("/events?c=s");
    check("GET /events is an SSE stream, as the harness serves it",
      res.headers.get("content-type")?.includes("text/event-stream") === true,
      String(res.headers.get("content-type")));
    const reader = res.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value ?? new Uint8Array());
    check("and it says hello immediately, so a client knows it is connected",
      first.startsWith(":"), JSON.stringify(first).slice(0, 60));
    // A broadcast must reach it — that is the whole contract.
    const soon = reader.read();
    h.cell.broadcast({ type: "probe", n: 1 });
    const got = new TextDecoder().decode((await soon).value ?? new Uint8Array());
    check("a broadcast reaches the stream as `data:` — this is what makes an answer ARRIVE",
      got.startsWith("data:") && got.includes("\"probe\""), JSON.stringify(got).slice(0, 90));
    // ONCE, NOT TWICE. A socket watcher gets a bare `{type}` notification for
    // every agent event and an SSE client gets the event itself. Mirroring the
    // notification too delivered everything twice — measured on dev
    // 2026-09-07: agent_start, turn_start, message_start and message_end each
    // arrived as themselves and again as a stub, and a consumer that renders
    // what it is sent would render the turn twice.
    const stub = reader.read();
    h.cell.broadcast({ type: "agent_start" }, { mirror: false });
    h.cell.broadcast({ type: "sentinel" });
    const after = new TextDecoder().decode((await stub).value ?? new Uint8Array());
    check("an event the stream already carried is not mirrored to it a second time",
      !after.includes("agent_start") && after.includes("sentinel"), JSON.stringify(after).slice(0, 110));
    await reader.cancel();
  }

  // Stop. The SDK calls /session/:id/abort at the RAW root with no prefix —
  // kortix-worker learned that against pi.kortix.com on 2026-09-01, where the
  // raw path 404'd, Stop did nothing, and the UI painted "Interrupted" from its
  // own receipt while the agent ran to completion.
  {
    const ok = await h.fetch("/session/s/abort?c=s", { method: "POST" });
    check("POST /session/:root/abort answers, whether or not a turn is running",
      ok.status === 200, `status ${ok.status}`);
    const wrong = await h.fetch("/session/someone-else/abort?c=s", { method: "POST" });
    check("and it refuses another session's abort rather than stopping this one",
      wrong.status === 404, `status ${wrong.status}`);
  }

  // The raw transcript the OpenCode client reads.
  {
    const r = await h.fetch("/session/s/message?c=s");
    const body = await r.json();
    check("GET /session/:root/message is a LIST of messages with parts",
      Array.isArray(body) && body.every((m) => m.info && Array.isArray(m.parts)), JSON.stringify(body).slice(0, 120));
    const wrong = await h.fetch("/session/nobody/message?c=s");
    check("and another session's transcript is not served from here",
      wrong.status === 404, `status ${wrong.status}`);
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
  // The spawn benchmark measures a SPAWN, which means each sample must be a
  // name that has never existed — a loop that reused one would report the cost
  // of a warm lookup and read as a spectacular result.
  {
    // A namespace that records every name it is asked for, so the claim below
    // is about the bench's behaviour and not about its own arithmetic.
    const spawnedNames = new Set();
    const AGENT = {
      idFromName: (n) => { spawnedNames.add(n); return n; },
      get: () => ({ fetch: async () => new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }) }),
    };
    const r = await worker.fetch(new Request("http://cell/bench/spawn?n=3"), { AGENT });
    const b = await r.json();
    check("the spawn bench reports a distribution, not one lucky sample",
      b.n === 3 && typeof b.p50 === "number" && typeof b.min === "number", JSON.stringify(b).slice(0, 140));
    // THE TWO READINGS MUST ACTUALLY DIFFER, or the decomposition is one
    // number printed twice. `/ping` answers before init(); `/turns` runs it.
    // The measured gap between them is the whole cost of a cell having state.
    const paths = [];
    const AGENT2 = {
      idFromName: (nm) => nm,
      get: () => ({ fetch: async (req) => { paths.push(new URL(req.url).pathname);
        return new Response("{}", { headers: { "content-type": "application/json" } }); } }),
    };
    await worker.fetch(new Request("http://cell/bench/spawn?n=2"), { AGENT: AGENT2 });
    check("by default the bench stops BEFORE init(), so the reading excludes storage",
      paths.every((p) => p === "/ping"), paths.join(","));
    paths.length = 0;
    const withInit = await worker.fetch(new Request("http://cell/bench/spawn?n=2&to=turns"), { AGENT: AGENT2 });
    check("and `to=turns` stops at a route that runs init() and reads a table",
      paths.every((p) => p === "/turns") && paths.length === 2, paths.join(","));
    check("the answer says which of the two it measured — a number with no path is not a reading",
      (await withInit.json()).stop === "/turns", "");
    check("and it asked for THREE DIFFERENT isolates — a reused name is not a spawn",
      spawnedNames.size === 3, `${spawnedNames.size} distinct names for n=3`);
  }

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

  // WHICH MODEL A SESSION GETS WHEN THE PLATFORM NAMES NONE.
  //
  // The control plane sends no model to a cell, so this fallback IS the model
  // for every session — it is not an edge case. It must therefore be the
  // platform's own default (PLATFORM_DEFAULT_MODEL_ID in packages/llm-catalog),
  // not whatever answered 200 the day it was written. Measured on dev
  // 2026-09-08, same cell and gateway, best of two: deepseek-v4-flash 2438 ms
  // total against glm-5.3-flash 5864 ms, and real turns on glm cost 8.5-23.8 s
  // of upstream time while the cell itself spends 3 ms.
  {
    const gw = makeCell(AgentCell, {
      ...ENV, KORTIX_LLM_BASE_URL: "https://gw.example/v1", KORTIX_TOKEN: "kt",
    });
    const m = await (await gw.fetch("/model?c=s")).json();
    check("a gateway session with no platform model falls back to the PLATFORM default",
      m.active?.id === "deepseek-v4-flash", JSON.stringify(m.active));
    // The fallback is only a floor: a platform that names a model still wins,
    // or an operator could never move a session off the default.
    const named = makeCell(AgentCell, {
      ...ENV, KORTIX_LLM_BASE_URL: "https://gw.example/v1", KORTIX_TOKEN: "kt", KORTIX_MODEL: "glm-5.3-flash",
    });
    const mn = await (await named.fetch("/model?c=s")).json();
    check("and a model the platform DOES name still wins over it",
      mn.active?.id === "glm-5.3-flash", JSON.stringify(mn.active));
  }

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
    // WHOSE MODEL. wrangler.json ships MODEL_ID as a bench default, and with
    // the node's value first that default beat the model the session was
    // started with — measured on dev 2026-09-07, session 6342be82: the turn ran
    // against provider `openai-codex` and returned empty content and zero
    // tokens, because the gateway does not speak the Codex Responses shape.
    const bench = makeCell(AgentCell, {
      ...ENV, MODEL_ID: "gpt-5.6-luna", MODEL_PROVIDER: "",
      KORTIX_LLM_BASE_URL: "https://gw.example/v1", KORTIX_TOKEN: "kt",
      KORTIX_MODEL: "glm-5.3-flash", KORTIX_PROVIDER: "openrouter",
    });
    const m = await (await bench.fetch("/model?c=s")).json();
    // And when the platform names NO model, the node's bench value must not
    // stand in for it: `gpt-5.6-luna` resolves to the Codex Responses API,
    // which the gateway does not speak, and the turn comes back empty.
    const noModel = makeCell(AgentCell, {
      ...ENV, MODEL_ID: "gpt-5.6-luna", MODEL_PROVIDER: "",
      KORTIX_LLM_BASE_URL: "https://gw.example/v1", KORTIX_TOKEN: "kt",
    });
    const nm = await (await noModel.fetch("/model?c=s")).json();
    // And the node's PROVIDER is not a fallback either: `celldctl deploy` bakes
    // the deploying machine's model config into the worker's vars, so whoever
    // deployed last would otherwise decide what every session talks to.
    const baked = makeCell(AgentCell, {
      ...ENV, MODEL_PROVIDER: "openai-codex", MODEL_ID: "gpt-5.6-luna",
      KORTIX_LLM_BASE_URL: "https://gw.example/v1", KORTIX_TOKEN: "kt",
    });
    const bm = await (await baked.fetch("/model?c=s")).json();
    check("a provider baked in by whoever deployed does NOT drive a gateway session",
      bm.active?.provider !== "openai-codex", JSON.stringify(bm.active));
    check("with a gateway and no platform model, the node's bench id is NOT used",
      nm.active === "scripted" || nm.active?.id !== "gpt-5.6-luna", JSON.stringify(nm.active));
    // AND IT IS NEVER EMPTY. Asked directly with a session's credential the
    // gateway answers 400 `"" is not a recognized model` — so "let the gateway
    // decide" was an empty string in a required field, and every turn came back
    // empty because the request was refused before it reached a model
    // (dev 2026-09-07).
    check("a gateway session always NAMES a model — an empty one is a 400, not a default",
      typeof nm.active?.id === "string" && nm.active.id.length > 0, JSON.stringify(nm.active));
    check("the PLATFORM's model wins over the node's bench default when a gateway is driving",
      m.active?.id === "glm-5.3-flash", JSON.stringify(m.active));
    check("and its provider does too, so the call is the shape the gateway speaks",
      m.active?.provider === "openrouter", JSON.stringify(m.active));

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
    // And a platform session with no sandbox gets the CELL's own filesystem —
    // the daemon at host.docker.internal:7070 does not exist on the platform,
    // and a session that fell through to it could answer questions but never
    // touch a file (dev 2026-09-07).
    const model = await (await hs.fetch("/model?c=s")).json();
    check("a synced platform session runs its tools on the cell's own filesystem",
      model.tools?.backend === "cell" && model.tools?.cwd === "/work", JSON.stringify(model.tools));
  }

  check("the worker answers /kortix/health with no session named", r.status === 200 && body.ok === true, JSON.stringify(body));
  // The session polls readiness BEFORE it has a session to name, so this body
  // has to classify too — an unclassifiable one leaves it waiting exactly as
  // long as an unreachable box would.
  check("and that answer classifies the same way as the in-cell one",
    body.daemon === "ok" && typeof body.runtime === "object" && body.runtime !== null && body.runtimeReady === true,
    JSON.stringify(body));
}

// ADDRESSING BY PATH MUST REACH THE SAME ROUTES AS ADDRESSING BY QUERY.
//
// The proxy in front of a session drops the query string, so `/session/<id>/…`
// is the only addressing the product has. Every one of these went to the
// catch-all before, and the catch-all answered 200.
{
  const h = makeCell(AgentCell, ENV);
  const byQuery = await (await h.fetch("/model?c=s")).json();
  const byPath = await (await h.fetch("/session/s/model")).json();
  check("a path-addressed request reaches the same route a query-addressed one does",
    byPath.tools?.backend === byQuery.tools?.backend && byPath.active !== undefined,
    JSON.stringify(byPath).slice(0, 120));

  const bare = await (await h.fetch("/session/s")).json();
  // OpenCode's `session.get`: ONE object. It was pinned as `[session]` here,
  // and the client read `session.time.created` on an array after a reload.
  check("a bare /session/<id> answers the session document, not a shrug",
    !Array.isArray(bare) && bare?.id === "s" && typeof bare.time?.created === "number", JSON.stringify(bare).slice(0, 120));

  const sse = await h.fetch("/session/s/events");
  check("the event stream is reachable under the name the product subscribes to",
    sse.headers.get("content-type")?.includes("text/event-stream"),
    String(sse.status) + " " + sse.headers.get("content-type"));

  // THE PRODUCT'S STREAM CARRIES THE WIRE, NOT pi's RAW EVENTS.
  //
  // `/global/event` aliased `/events`, which pushes AgentEvents verbatim —
  // `turn_started`, `message_start`, `text`. The web client repaints only on
  // `message.part.delta`, so the answer arrived on the stream and rendered
  // nothing until a transcript poll caught up. Measured end to end through the
  // browser's own path 2026-09-09: 0 delta frames, and types `text`,
  // `turn_started`, `agent_start`.
  // ONE CHUNK, never .text(): an event stream has no end, so reading the whole
  // body hangs the suite forever. The first version did exactly that.
  const firstChunk = async (res) => {
    const r = res.body.getReader();
    const { value } = await r.read();
    await r.cancel().catch(() => {});
    return new TextDecoder().decode(value ?? new Uint8Array());
  };
  const wire = await h.fetch("/session/s/global/event");
  const wireHead = await firstChunk(wire).catch(() => "");
  check("/global/event opens the OpenCode wire — it starts with kortix.hello",
    wireHead.startsWith("event: kortix.hello"), wireHead.slice(0, 60));
  check("and it carries the epoch header the API reads",
    wire.headers.get("x-kortix-epoch") !== null, String(wire.headers.get("x-kortix-epoch")));

  const raw = await h.fetch("/session/s/events");
  const rawHead = await firstChunk(raw).catch(() => "");
  check("/events still carries the RAW harness contract, unchanged",
    rawHead.startsWith(": connected"), rawHead.slice(0, 40));

  // The example moved: `/kortix/opencode/state` was the unserved route this
  // claim pointed at, and the cell serves it now — the claim noticed, which is
  // the only reason this comment exists. `/kortix/opencode/messages/:id` is the
  // control plane's next unimplemented read.
  const unknown = await h.fetch("/session/s/kortix/opencode/messages/msg-1");
  check("a route the cell does not serve is a 404, not a 200 that looks served",
    unknown.status === 404 && (await unknown.json()).ok === false, String(unknown.status));
}

// THE ONE CELL NAME celld CANNOT ROUTE.
//
// Measured on dev 2026-09-09 on a box thirty seconds old: `?c=default` is
// `DurableObjectRoutingError: The Durable Object owner is currently
// unreachable`, while `Default`, `DEFAULT`, `default1`, `main`, `agent` and a
// uuid all answer. This worker used to fall back to exactly that name whenever
// a box came back without `KORTIX_SESSION_ID`, so every request the product
// made to a resumed cell died at the router.
{
  const reached = [];
  const AGENT = {
    idFromName: (name) => ({ toString: () => name, name }),
    get: (id) => { reached.push(id.name); return { fetch: async () => Response.json({ ok: true }) }; },
  };
  const worker = mod.default;
  const d = await worker.fetch(new Request("http://cell/model?c=default"), { AGENT });
  check("the worker refuses the unroutable name instead of handing it to celld",
    d.status === 503 && reached.length === 0, String(d.status) + " reached=" + JSON.stringify(reached));

  const none = await worker.fetch(new Request("http://cell/model"), { AGENT });
  check("a box with no session refuses rather than inventing one",
    none.status === 503 && reached.length === 0, String(none.status) + " reached=" + JSON.stringify(reached));

  const named = await worker.fetch(new Request("http://cell/model"), { AGENT, KORTIX_SESSION_ID: "sess-1" });
  check("and a box that knows its session still routes to it",
    named.status === 200 && reached[reached.length - 1] === "sess-1", JSON.stringify(reached));
}


// THE WIRE FRAMES MUST NAME THE SESSION THE PRODUCT KNOWS.
//
// A turn runs in `alarm()`, which has no request to read `?c=` from, so the
// only session name in scope is celld's own 64-hex object id. Built from that,
// every frame named a session no client has heard of — measured on dev
// 2026-09-09, 117 deltas carrying `"sessionID":"5e46f994978d338d…"` for
// session 69658df3-b530-410f-b5d6-2f89822f00c9.
{
  const h = makeCell(AgentCell, { ...ENV, KORTIX_SESSION_ID: "node-session" });
  const cell = h.cell ?? h;
  check("a turn's own session wins — the node's env names whoever made the box",
    cell.wireSessionId({ session_id: "turn-session" }, "object-id") === "turn-session",
    String(cell.wireSessionId({ session_id: "turn-session" }, "object-id")));
  check("with no session on the turn, the node's env is better than the object id",
    cell.wireSessionId({}, "object-id") === "node-session",
    String(cell.wireSessionId({}, "object-id")));
  check("and the object id is the last resort, not the first",
    cell.wireSessionId({}, "object-id") !== "object-id", "");
}


// THE CELL SAYS HOW LONG IT TOOK, so a caller's number can be split.
//
// A caller timing a cell measures connection + hop + isolate + hop. When it is
// wrong, nothing says which. Measured 2026-09-09: the API's env repair
// reported `post: 73 ms` against a POST that answered in 9 ms p50 from a warm
// connection elsewhere, and neither side could name the other 64 ms.
{
  const h = makeCell(AgentCell, ENV);
  const r = await h.fetch("/model?c=s");
  const v = r.headers.get("x-cell-ms");
  check("every answer carries the cell's own service time",
    v !== null && Number.isFinite(Number(v)) && Number(v) >= 0, String(v));

  // A route that answers before init() must carry it too — that one is the
  // spawn path, and it is the reading the whole comparison rests on.
  const ping = await h.fetch("/ping?c=s");
  check("including /ping, which answers before init() and is what spawn is timed on",
    Number.isFinite(Number(ping.headers.get("x-cell-ms"))), String(ping.headers.get("x-cell-ms")));

  // A MEASUREMENT, NOT A CONSTANT. The first version of this claim compared a
  // cheap route against an expensive one and passed under a mutant that
  // reported a hardcoded "0" — because 0 >= 0. A whole scripted turn cannot
  // take zero milliseconds: it runs the model fixture and writes the
  // transcript to SQLite.
  const turn = await h.fetch("/prompt?c=s", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "go", script: [{ text: "answered" }] }),
  });
  check("and it is a measurement, not a constant — a whole turn cannot take 0 ms",
    Number(turn.headers.get("x-cell-ms")) > 0, String(turn.headers.get("x-cell-ms")));

  // The projection asks the cell about itself. If that inner call went through
  // `fetch` it would start a second clock inside the first.
  const proj = await h.fetch("/kortix/opencode/state?c=s");
  check("the projection still answers, with the cell asking itself through handle()",
    proj.status === 200 && (await proj.json()).identity !== undefined, String(proj.status));
}


// THE SPAWN BENCH IS THE COMPARISON, so it must keep saying what it measured.
//
// Its comment carries the whole agentOS comparison — 4.8 ms in-process against
// this worker's numbers, and now the memory slope beside it. A bench whose
// answer stops naming its own conditions is a number without a method, which
// is what every stale claim in this repo started as.
{
  const worker = mod.default;
  const AGENT = {
    idFromName: (n) => n,
    get: () => ({ fetch: async () => Response.json({ ok: true }) }),
  };
  const b = await (await worker.fetch(new Request("http://cell/bench/spawn?n=2"), { AGENT })).json();
  check("the bench states the quantity it is comparable to, not just a number",
    typeof b.note === "string" && b.note.includes("in-node"), JSON.stringify(b.note));
  check("and it reports how many samples the distribution came from",
    b.n === 2, String(b.n));

  // COLD AND WARM ARE DIFFERENT QUESTIONS, and a bench that quietly reports the
  // flattering one is how a number outlives its method. agentOS's 4.8 ms is an
  // in-process dispatch with no isolate to create; only the warm reading here
  // is the same quantity, and the answer has to say which it gave.
  {
    const names = [];
    const A2 = {
      idFromName: (n) => { names.push(n); return n; },
      get: () => ({ fetch: async () => Response.json({ ok: true }) }),
    };
    const cold = await (await worker.fetch(new Request("http://cell/bench/spawn?n=4"), { AGENT: A2 })).json();
    check("cold is the DEFAULT — four samples, four isolates that never existed",
      cold.mode === "cold" && new Set(names).size === 4, `${cold.mode} ${new Set(names).size}`);
    check("and it says so, rather than implying the comparable number",
      cold.note.includes("COLD"), cold.note);

    names.length = 0;
    const hot = await (await worker.fetch(new Request("http://cell/bench/spawn?n=4&warm=1"), { AGENT: A2 })).json();
    check("warm asks for ONE isolate, which is what makes it a dispatch and not a spawn",
      hot.mode === "warm" && new Set(names).size === 1, `${hot.mode} ${new Set(names).size}`);
    check("and it pays for that isolate outside the clock — 4 samples, 6 requests",
      names.length === 6, `${names.length} requests for n=4`);
    check("and its note claims the agentOS quantity, which the cold one must not",
      hot.note.includes("4.8 ms") && !cold.note.includes("4.8 ms"), hot.note);

    // THE TAIL MUST HAVE AN OWNER. A cold sample is celld reaching an isolate
    // plus the isolate answering; the callee reports the second half in
    // `x-cell-ms`, so the bench can subtract it. Measured on a QUIET box, the
    // worst of 100 cold spawns was 15062 ms — a number that says nothing at
    // all until it is attributed.
    const withHeader = {
      idFromName: (n) => n,
      get: () => ({ fetch: async () => new Response("{}", {
        headers: { "content-type": "application/json", "x-cell-ms": "2" },
      }) }),
    };
    const attributed = await (await worker.fetch(
      new Request("http://cell/bench/spawn?n=4"), { AGENT: withHeader })).json();
    check("a cold reading splits into dispatch and isolate, not one opaque number",
      attributed.dispatch !== null && typeof attributed.dispatch.p50 === "number",
      JSON.stringify(attributed.dispatch));
    check("and the dispatch half excludes what the isolate reported",
      attributed.dispatch.p50 <= attributed.p50, `${attributed.dispatch.p50} vs ${attributed.p50}`);

    // A callee that reports nothing must not be invented a number for.
    const noHeader = {
      idFromName: (n) => n,
      get: () => ({ fetch: async () => Response.json({ ok: true }) }),
    };
    const blind = await (await worker.fetch(
      new Request("http://cell/bench/spawn?n=3"), { AGENT: noHeader })).json();
    check("with no x-cell-ms there is no dispatch split, rather than a made-up one",
      blind.dispatch === null, JSON.stringify(blind.dispatch));
  }
}


// A CELL THAT HAS NOT LOOKED MUST NOT SAY ITS FILES ARE GONE.
//
// `files` was gated on `this.cellFs`, an instance field a REBUILT isolate does
// not have until something builds tools again — so every eviction made a cell
// report 0 files. Measured on dev 2026-09-09 on a dedicated box: before the
// rebuild files=2, after it files=0, and the agent then read its own file back
// by content in the very next turn. The data survived; the count did not.
{
  const h = makeCell(AgentCell, { ...ENV, TOOLS_BACKEND: "cell" });
  const cell = h.cell ?? h;

  // Before any tool build there is no table. That is unknown, not zero.
  check("a cell with no files table reports null rather than claiming none",
    cell.fileCount() === null, String(cell.fileCount()));
  const fresh = await (await h.fetch("/model?c=s")).json();
  check("and /model carries that null through instead of a false 0",
    fresh.tools?.files === null, JSON.stringify(fresh.tools));

  // With a table and rows, the count is the rows — with no cellFs in sight,
  // which is exactly the state a rebuilt isolate is in.
  cell.sql.exec("CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, body TEXT)");
  cell.sql.exec("INSERT INTO files(path, body) VALUES ('/work/a.txt', 'a')");
  cell.sql.exec("INSERT INTO files(path, body) VALUES ('/work/b.txt', 'b')");
  check("a rebuilt isolate counts the rows that outlived it, without cellFs",
    cell.cellFs === undefined && cell.fileCount() === 2, `cellFs=${cell.cellFs} count=${cell.fileCount()}`);
  const after = await (await h.fetch("/model?c=s")).json();
  check("and /model reports them, which is what an eviction used to hide",
    after.tools?.files === 2, JSON.stringify(after.tools));
}


// A PROJECTION ANSWERS FOR THE SESSION IT WAS ASKED ABOUT.
//
// `fetchRuntimeState` always names the session; the cell must not answer for
// the one that happens to be in the node's env. On a shared host that is
// whoever created the BOX, and a session's FIRST projection is read before it
// has run a turn — so every session stored a projection under a stranger's id,
// the control plane compared it with the real pin, and served
// `identity_mismatch` for the life of the session.
//
// Measured on dev 2026-09-09: GET /kortix/opencode/state?c=never-had-a-turn-N
// answered `identity.opencode_session_id = f6fc9d40-…`, the box's creator.
{
  const h = makeCell(AgentCell, { ...ENV, KORTIX_SESSION_ID: "whoever-made-the-box" });
  const doc = await (await h.fetch("/kortix/opencode/state?c=a-session-with-no-turns")).json();
  check("a cell with no turns still answers for the session it was addressed as",
    doc.identity.opencode_session_id === "a-session-with-no-turns",
    doc.identity.opencode_session_id);
  check("and its session list names that session too, not the node's",
    doc.sessions.value[0]?.id === "a-session-with-no-turns",
    JSON.stringify(doc.sessions.value[0]?.id));
  check("its status is keyed by that session, or the UI reads nobody's state",
    Object.keys(doc.statuses.value)[0] === "a-session-with-no-turns",
    JSON.stringify(Object.keys(doc.statuses.value)));

  // The node's env is still the answer when the caller named nobody — that is
  // the one case where it is the best available.
  const un = await (await h.fetch("/kortix/opencode/state")).json();
  check("with no session named at all, the node's own is used rather than nothing",
    un.identity.opencode_session_id === "whoever-made-the-box", un.identity.opencode_session_id);
}


// A RESUMED BOX RE-LEARNS ITS SESSION FROM ITS OWN TRAFFIC.
//
// `sandbox.start` does not carry envVars, so a restarted cell has no
// KORTIX_SESSION_ID at all — measured on two of the user's boxes 2026-09-09,
// both restarted at 11:36, both answering 503 to every in-box call the web
// client makes. The node learns from the requests that DO name a session.
{
  // A FRESH MODULE INSTANCE. What the node has been asked about is module
  // state, and every earlier claim in this file has named a session — so a
  // shared instance is already "ambiguous" and would refuse for the wrong
  // reason. This is the same trick test/build-and-model.mjs uses.
  const fresh = await import(`../dist/worker.js?relearn=${Date.now()}`);
  const worker = fresh.default;
  const reached = [];
  const AGENT = {
    idFromName: (n) => ({ toString: () => n, name: n }),
    get: (id) => { reached.push(id.name); return { fetch: async () => Response.json({ ok: true }) }; },
  };
  const noEnv = { AGENT };   // exactly what a resumed box looks like

  const before = await worker.fetch(new Request("http://cell/model"), noEnv);
  check("a node that has been asked about nothing refuses — nothing is invented",
    before.status === 503, String(before.status));

  await worker.fetch(new Request("http://cell/session/learned-one/message"), noEnv);
  reached.length = 0;
  const after = await worker.fetch(new Request("http://cell/model"), noEnv);
  check("an addressed request teaches the node, so the next unaddressed one resolves",
    after.status === 200 && reached.includes("learned-one"),
    `${after.status} reached=${JSON.stringify(reached)} (baseline ${before.status})`);

  // A SECOND session makes it ambiguous, and ambiguous must mean refused —
  // serving the first would hand one user another user's stream.
  await worker.fetch(new Request("http://cell/session/learned-two/message"), noEnv);
  reached.length = 0;
  const ambiguous = await worker.fetch(new Request("http://cell/model"), noEnv);
  check("with two sessions known, an unaddressed request is REFUSED, not served the first",
    ambiguous.status === 503 && !reached.includes("learned-one"),
    `${ambiguous.status} reached=${JSON.stringify(reached)}`);

  // And naming one explicitly still works regardless of what the node knows.
  reached.length = 0;
  const explicit = await worker.fetch(new Request("http://cell/model?c=learned-two"), noEnv);
  check("an explicit ?c= is unaffected by any of this",
    explicit.status === 200 && reached[reached.length - 1] === "learned-two",
    JSON.stringify(reached));
}

// THE OPENCODE BOOT SURFACE, THROUGH THE CELL. On a page refresh the web client
// calls these before it will talk to a session; on dev 2026-09-09, session
// 5192652f, every one answered 404 and the page never connected.
{
  const env = { ...ENV, KORTIX_AGENT_NAME: "kortix", KORTIX_PROJECT_ID: "proj-1", MODEL_PROVIDER: "openrouter", MODEL_ID: "deepseek-v4-flash" };
  const hb = makeCell(AgentCell, env);
  const codes = {};
  for (const p of ["/agent", "/command", "/global/config", "/project/current", "/permission", "/question", "/lsp/diagnostics"]) {
    codes[p] = (await hb.fetch(`${p}?c=s`)).status;
  }
  check("every boot route the client calls on refresh answers 200 through the cell",
    Object.values(codes).every((c) => c === 200), JSON.stringify(codes));
  const agent = await (await hb.fetch("/agent?c=s")).json();
  check("and /agent names the session's agent from the cell's own env",
    Array.isArray(agent) && agent[0]?.name === "kortix" && agent[0]?.model?.modelID === "deepseek-v4-flash", JSON.stringify(agent).slice(0, 140));
  const cfg = await (await hb.fetch("/global/config?c=s")).json();
  check("and /global/config carries the model the way the client splits it",
    cfg.model === "openrouter/deepseek-v4-flash", JSON.stringify(cfg));
  check("a route the cell does serve is not shadowed by the boot surface",
    (await hb.fetch("/session?c=s")).status === 200 && (await hb.fetch("/nope?c=s")).status === 404, "");
}

// THE TRANSCRIPT ANSWERS IN THE IDS THE WIRE USED. Same session, same day: the
// stream painted `msg_0879…` and `msg_cell_00000001`, the poll answered `1`
// and `2`, and every message showed twice.
{
  const db = new DatabaseSync(":memory:");
  const env = { ...ENV, SCRIPT: JSON.stringify([{ text: "sup!" }, { text: "again" }]) };
  const h1 = makeCell(AgentCell, env, { db });
  await h1.fetch("/session/s/prompt_async?c=s", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ messageID: `msg_${((BigInt(Date.now() - 120000) * 0x1000n) & 0xffffffffffffn).toString(16).padStart(12, "0")}AAAAAAAAAAAAAA`, parts: [{ type: "text", text: "suppp" }] }),
  });
  await h1.drain();
  const t1 = await (await h1.fetch("/session/s/message?c=s")).json();
  const user = t1.find((m) => m.info.role === "user"); const asst = t1.find((m) => m.info.role === "assistant");
  check("the user message is named by the messageID the client sent",
    /^msg_[0-9a-f]{12}AAAAAAAAAAAAAA$/.test(user?.info.id ?? "") && user.parts[0]?.messageID === user.info.id, JSON.stringify(t1).slice(0, 200));
  check("the assistant message is named by a WIRE id the stream minted — the client's own time-sortable shape — parts included",
    /^msg_[0-9a-f]{12}[A-Za-z0-9]{14}$/.test(asst?.info.id ?? "") && asst.parts[0]?.id === `${asst.info.id}-p0`, JSON.stringify(asst).slice(0, 200));

  // A REBUILT ISOLATE MUST NOT MINT AN ID THE TRANSCRIPT ALREADY HOLDS.
  const h2 = makeCell(AgentCell, env, { db });
  await h2.fetch("/session/s/prompt_async?c=s", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ messageID: `msg_${((BigInt(Date.now() - 120000) * 0x1000n) & 0xffffffffffffn).toString(16).padStart(12, "0")}ZZZZZZZZZZZZZZ`, parts: [{ type: "text", text: "and?" }] }),
  });
  await h2.drain();
  const t2 = await (await h2.fetch("/session/s/message?c=s")).json();
  const ids = t2.filter((m) => m.info.role === "assistant").map((m) => m.info.id);
  check("after an eviction the next assistant id still sorts strictly after the previous one — by id, as the client orders",
    ids.length === 2 && ids[0] < ids[1] && ids[0] !== ids[1], JSON.stringify(ids));
  // THE ORDER THE CLIENT PAINTS: by id. Two turns whose user ids are real wire
  // ids must interleave user, assistant, user, assistant — measured wrong on
  // session 89848ff8 with counter ids.
  const all = t2.map((m) => m.info);
  const byId = [...all].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((m) => m.role);
  check("sorted by id the transcript reads user, assistant, user, assistant",
    JSON.stringify(byId) === JSON.stringify(["user", "assistant", "user", "assistant"]), JSON.stringify(byId));
}

// `/session/status` IS A ROUTE. OpenCode answers a map keyed by session id; the
// cell took "status" for a session name, answered the root ARRAY, and taught the
// node a session called "status" — after which unaddressed requests were 503.
{
  const hs = makeCell(AgentCell, ENV);
  const st = await (await hs.fetch("/session/status?c=s")).json();
  check("GET /session/status answers OpenCode's keyed map, not an array",
    !Array.isArray(st) && st.s && (st.s.type === "idle" || st.s.type === "busy"), JSON.stringify(st).slice(0, 120));
  const learned = await (await hs.fetch("/session?c=s")).json();
  check("and the node did not learn a session named 'status'",
    Array.isArray(learned) && learned.every((x) => x.id !== "status"), JSON.stringify(learned).slice(0, 120));
}

// Two routes an OpenCode client polls that 404'd in a real browser's boot.
{
  const ht = makeCell(AgentCell, ENV);
  const todo = await ht.fetch("/session/s/todo?c=s");
  check("GET /session/:id/todo answers an empty list, not 404 — the client polls it",
    todo.status === 200 && Array.isArray(await todo.json()), String(todo.status));
  const log = await ht.fetch("/log?c=s", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ level: "info", message: "hi" }) });
  check("POST /log is accepted the way OpenCode answers it (true)", log.status === 200 && (await log.json()) === true, String(log.status));
  check("a todo list for another session is still refused",
    (await ht.fetch("/session/other/todo?c=s")).status === 404, "");
}

// `GET /session/<id>` is session.get — ONE object. Answering the list here
// crashed the chat after a reload: `session.time.created` on an array.
{
  const hg = makeCell(AgentCell, ENV);
  const one = await (await hg.fetch("/session/s?c=s")).json();
  const list = await (await hg.fetch("/session?c=s")).json();
  check("GET /session/<id> answers ONE session object with its time — not the list",
    !Array.isArray(one) && one.id === "s" && typeof one.time?.created === "number", JSON.stringify(one).slice(0, 120));
  check("and GET /session is still the list", Array.isArray(list) && list[0]?.id === "s", JSON.stringify(list).slice(0, 80));
}

process.exit(bad ? 1 : 0);
