// AGENT CELL — a pi agent loop living inside a Durable Object.
//
// The claim being tested: a coding agent can run in a V8 isolate with NO
// filesystem and NO child processes, keep its transcript in the cell's own
// SQLite (which celld replicates to object storage), hibernate to nothing
// between turns, and come back with its conversation intact.
//
// Three things make that work, and each is a decision rather than a detail:
//
//  1. pi-agent-core, not pi-coding-agent. The latter imports node:fs,
//     fs/promises, path and readline at module top level — 106 unresolved
//     imports when bundled for a worker target. agent-core bundles clean.
//     Measured, not assumed; see README.md.
//
//  2. STORAGE IS TRUTH, MEMORY IS CACHE. `agent.state.messages` is rebuilt from
//     SQLite on every wake. An isolate can be evicted between any two requests,
//     so anything held only in a field is already lost.
//
//  3. Tools are HTTP calls carrying pi's own toolCallId as an idempotency key,
//     so a crash mid-command and a resume elsewhere retries safely.
// A STRICT atob IS WHY A CHATGPT SUBSCRIPTION DID NOT WORK IN A CELL.
//
// pi's Codex provider reads the ChatGPT account id out of the OAuth access
// token: `JSON.parse(atob(jwt.split(".")[1]))`. JWT segments are base64URL and
// carry NO PADDING. Node's atob tolerates that; the isolate's atob implements
// the spec and throws `Invalid base64`, which surfaces four layers up as the
// unhelpful `Failed to extract accountId from token`.
//
// Measured rather than guessed: the token reached the cell intact — 1680 chars,
// 3 segments — and the same string that node decodes fine failed here. The
// segment needed exactly 2 characters of padding.
//
// So pad it (and accept base64url's - and _ while we are here) before
// delegating. This runs before any provider is loaded, and is a no-op for
// input that was already valid.
const nativeAtob = globalThis.atob;
globalThis.atob = (input) => {
  let s = String(input).replace(/-/g, "+").replace(/_/g, "/");
  const rem = s.length % 4;
  if (rem === 2) s += "==";
  else if (rem === 3) s += "=";
  else if (rem === 1) return nativeAtob(input); // genuinely malformed — let it throw natively
  return nativeAtob(s);
};

import { Agent } from "@earendil-works/pi-agent-core";
import { cellFs, cellShellNote } from "./execenv.cell.js";
import { executionEnvFor, piTools, piToolsCell, piToolsPlatinum } from "./pitools.js";
import { invokeSkill, loadWorkspaceSkills, withSkills } from "./skills.js";
// tools.platinum.js is retired for the worker: bash/read/write/list/grep go
// through the ExecutionEnv in execenv.platinum.js (see pitools.js). The module
// stays for platinum-shapes.mjs, which unit-tests its ledger and bodies.
import { providerStream, resolveModel, scriptedStream, supportedProviders } from "./model.js";
import { SUMMARY_PROMPT, compactionState, maybeCompact } from "./compaction.js";
import { WireBus, WIRE_HEARTBEAT_MS } from "./wire.js";
import { runtimeStateDoc, projectionEtag } from "./projection.js";
import { ChatEventAdapter } from "../../kortix-worker/src/chat-events.ts";

const streamFnOf = (agent) => agent.__streamFn;

const SYSTEM_PROMPT =
  "You are a coding agent working in a remote workspace. " +
  "You have no local filesystem: use the bash, read and write tools, which run in the workspace. " +
  "Be concise.";

// How much summarised transcript a cell keeps for audit. Past this the oldest
// archived messages are dropped — the record is bounded, and says so, rather
// than growing until the cell's storage becomes the problem.
const ARCHIVE_MAX_BYTES = 8 * 1024 * 1024;

// Paths that do not bill. Observability and liveness: a monitor polling these
// must not move a customer's invoice.
const UNBILLED_PATHS = new Set(["/health", "/meter", "/sockets"]);

// How many requests may go uncounted in storage at once. 20 turns a 154 ms
// per-request floor into ~8 ms amortised, and bounds what a rebuild can lose
// to requests nobody read back.
const REQUEST_FLUSH_EVERY = 20;

const SCRIPTED_MODEL = { id: "scripted", api: "anthropic-messages", provider: "scripted", name: "scripted" };

// WHICH MODEL, entirely from config. MODEL_PROVIDER is any id pi ships
// (openai, anthropic, google, xai, groq, deepseek, mistral, openrouter,
// cerebras, fireworks, together, moonshotai, github-copilot, google-vertex,
// azure-openai-responses, ...); MODEL_BASE_URL redirects an OpenAI-compatible
// one at a gateway or a test double. With no key it stays scripted, so the
// tests neither need credentials nor spend money.
// WHICH TOOL BACKEND. `platinum` calls the platform's own sandbox API with a
// `sandbox:<id>`-scoped key — the credential sandboxScope.ts was built to hand
// an agent. `daemon` is the standalone HTTP service, kept for local runs where
// there is no control plane to call.
//
// Defaulting to platinum when its three variables are present, rather than to a
// config flag, so a deployment that HAS a scoped key cannot accidentally keep
// talking to a daemon that is not there.
function toolsFor(env, sessionId, sql, owner) {
  const wantsPlatinum = env.PT_API_URL && env.PT_SANDBOX_KEY && env.PT_WORKSPACE_ID;
  // A PLATFORM SESSION WITH NO WORKSPACE GETS THE CELL'S OWN FILESYSTEM.
  //
  // Measured on dev 2026-09-07: a Kortix session's cell carried fourteen
  // KORTIX_* variables and no PT_*, so tools fell through to a daemon at
  // host.docker.internal:7070 that does not exist on the platform — every
  // bash call failed with "error sending request", and the session could
  // answer questions but never touch a file. The cell can now carry its own
  // tree and shell (execenv.cell.js), so that fallback is the right default
  // whenever a gateway is driving and nobody handed the session a sandbox.
  // Explicit TOOLS_BACKEND=cell asks for it anywhere; a bench with a daemon is
  // unchanged.
  const platform = Boolean(normalizeModelEnv(env).MODEL_BASE_URL) || Boolean(env.KORTIX_SESSION_ID);
  if (!wantsPlatinum && owner && (env.TOOLS_BACKEND === "cell" || (platform && !env.TOOL_DAEMON_URL_FORCE))) {
    owner.cellFs ??= cellFs(sql);
    return piToolsCell(env, sessionId, sql, owner.cellFs);
  }
  // The daemon backend now runs pi's OWN tools over an ExecutionEnv — bash,
  // read, write and, the one that matters, edit. The hand-rolled set is
  // retired: it maintained three tools worse than pi does and had no edit at
  // all, so every change to a file cost a whole-file rewrite.
  if (!wantsPlatinum) return piTools(env, sessionId, sql);
  // Platinum: the same six tools, over the sandbox API.
  //
  // list and grep used to come from tools.platinum.js here, against Platinum's
  // native routes — which is why the Platinum path had six tools and the daemon
  // path four. They are now written once against the ExecutionEnv and served by
  // both, so the model's abilities do not depend on which backend a deployment
  // happens to use.
  return piToolsPlatinum(env, sessionId, sql);
}

// WHAT THE SESSION IS PRICED AT, which is not the same question as what it
// RUNS. A price comes from the catalogue and needs no credential, so
// MODEL_PROVIDER + MODEL_ID alone are enough to answer "what would this cost on
// claude-sonnet-5" — useful before a key exists, and the only way a scripted
// test can exercise the money path without turning the scripted model off.
//
// modelConfig() below still decides what actually runs, and it needs the key.
/**
 * THE PLATFORM'S NAMES FOR THE SAME FOUR THINGS.
 *
 * A cell reads MODEL_PROVIDER / MODEL_API_KEY / MODEL_ID / MODEL_BASE_URL. The
 * Kortix control plane injects KORTIX_PROVIDER / KORTIX_TOKEN / KORTIX_MODEL /
 * KORTIX_LLM_BASE_URL (provisionSessionSandbox). Nothing translated between
 * them, so a real session arrived with a gateway, a credential and a model and
 * the cell found no key at all — it stayed scripted and answered nothing, with
 * every health field reporting fine. Measured on dev 2026-09-07: sessions
 * dee5338a and 5b482709 ran their turns to `done` with no model behind them.
 *
 * The mapping is kortix-worker's (configFromEnv in
 * apps/kortix-worker/src/worker.ts), including the rule that matters most:
 * KORTIX_TOKEN is a CONTROL-PLANE credential and is only valid as model auth
 * when it is being sent to the Kortix gateway. With no gateway URL there is no
 * key, and the cell stays scripted rather than posting a session token to an
 * external provider.
 *
 * Explicit MODEL_* always wins, so a bench, a suite or an operator can pin a
 * model without the platform's names getting in the way.
 */
// The model a gateway session falls back to when the platform names none.
// An empty model is not an option: the gateway answers 400 `model_not_found`.
//
// THIS MUST BE THE PLATFORM'S OWN DEFAULT, not a model that merely works.
// It is `PLATFORM_DEFAULT_MODEL_ID` in packages/llm-catalog — the value
// `config.LLM_GATEWAY_DEFAULT_MODEL` takes when an operator names none — and
// picking anything else here silently overrides a deployment-wide choice for
// every cell session, because the control plane does not send a model at all.
//
// It used to be `glm-5.3-flash`, chosen on 2026-09-07 for no better reason than
// that it answered 200. Measured on dev 2026-09-08, same cell, same gateway,
// same prompt, best of two:
//
//   deepseek-v4-flash    headers  906 ms   total  2438 ms
//   glm-5.3-flash        headers 5816 ms   total  5864 ms
//
// and on real session turns glm took 8.5 s, 23.4 s and 23.8 s of upstream time
// (the gateway's own log). So the arbitrary pick was costing every turn several
// seconds and the sessions felt slow for a reason that had nothing to do with
// the cell, which spends 3 ms.
const GATEWAY_FALLBACK_MODEL = "deepseek-v4-flash";

function normalizeModelEnv(env) {
  // `??` IS THE WRONG OPERATOR HERE, and it cost a whole session.
  //
  // wrangler.json declares MODEL_PROVIDER and MODEL_BASE_URL as "" so the
  // bindings exist for a scripted run. An empty string is not nullish, so
  // `env.MODEL_BASE_URL ?? env.KORTIX_LLM_BASE_URL` answers "" and the
  // platform's gateway is never reached — which makes the key undefined, which
  // makes the cell scripted. Measured on dev 2026-09-07, session 3cd59929: all
  // fourteen KORTIX_* variables present on the isolate, a gateway URL and a
  // token among them, and model_mode still "scripted".
  //
  // So: the first value that is actually SET wins, and a declared-but-empty
  // binding counts as unset.
  const pick = (...vals) => vals.find((v) => typeof v === "string" && v.length > 0);
  const gateway = pick(env.MODEL_BASE_URL, env.KORTIX_GATEWAY_URL, env.KORTIX_LLM_BASE_URL);
  const key = pick(env.MODEL_API_KEY, env.KORTIX_API_KEY, gateway ? env.KORTIX_TOKEN : undefined);
  // WHOSE MODEL IS IT. A gateway means the platform is driving this session, so
  // ITS model and provider win over the node's — wrangler.json ships
  // MODEL_ID "gpt-5.6-luna" as a bench default, and with the node first that
  // default beat the model the session was actually started with.
  //
  // Measured on dev 2026-09-07, session 6342be82: the turn ran to `done`
  // against provider `openai-codex` with the Codex Responses API, and came back
  // with empty content and zero tokens — the gateway does not speak that shape.
  // The platform had said which model to use and was not asked.
  //
  // With no gateway nothing is driving the session, so the node's own values
  // are the answer and a bench keeps working unchanged.
  const platform = Boolean(gateway);
  return {
    ...env,
    // THE NODE'S PROVIDER IS NOT A FALLBACK EITHER, for the same reason its
    // model id is not: `celldctl deploy` bakes the DEPLOYING MACHINE's model
    // config into the worker's vars (syncWorkerVars), so whoever last deployed
    // decides what every session on that worker talks to. Mine put
    // `openai-codex` there, and the sessions dutifully spoke the Codex
    // Responses shape at a gateway that does not (dev 2026-09-07: turns ran to
    // `done`, empty content, zero tokens). Under a gateway the provider is the
    // platform's or the OpenAI-compatible default the gateway serves.
    MODEL_PROVIDER: platform
      ? pick(env.KORTIX_PROVIDER, key ? "openrouter" : undefined)
      : pick(env.MODEL_PROVIDER),
    // NO NODE FALLBACK FOR THE MODEL ID when the platform is driving — the
    // node's is a bench value, and `gpt-5.6-luna` resolves to the Codex
    // Responses API, which the gateway does not speak (dev 2026-09-07: turns
    // ran to `done` with empty content and zero tokens).
    //
    // BUT UNSET IS NOT A CHOICE THE GATEWAY ACCEPTS. Asked directly with a
    // session's own credential it answers 400 `"" is not a recognized model`,
    // and with a model it answers 200 and a completion. So "let the gateway
    // decide" was not an option that existed; it was an empty string in a
    // required field, and the turn came back empty because the request was
    // refused before it ever reached a model.
    //
    // The platform's model is used when it names one. When it does not, this
    // names one the gateway serves rather than sending nothing — overridable,
    // because which model a deployment defaults to is a product decision and
    // not this file's to fix forever.
    MODEL_ID: platform
      ? pick(env.KORTIX_MODEL, env.KORTIX_DEFAULT_MODEL, GATEWAY_FALLBACK_MODEL)
      : pick(env.MODEL_ID),
    MODEL_BASE_URL: gateway,
    MODEL_API_KEY: key,
  };
}

function pricedModel(rawEnv) {
  const env = normalizeModelEnv(rawEnv ?? {});
  if (!env.MODEL_PROVIDER || !env.MODEL_ID) return null;
  try { return resolveModel({ provider: env.MODEL_PROVIDER, modelId: env.MODEL_ID, baseUrl: env.MODEL_BASE_URL }); }
  catch { return null; }
}

function modelConfig(rawEnv) {
  const env = normalizeModelEnv(rawEnv ?? {});
  const provider = env.MODEL_PROVIDER;
  const apiKey = env.MODEL_API_KEY;
  if (!provider || !apiKey) return null;
  return {
    model: resolveModel({ provider, modelId: env.MODEL_ID, baseUrl: env.MODEL_BASE_URL }),
    streamFn: providerStream(provider),
    getApiKey: () => apiKey,
  };
}

export class AgentCell {
  constructor(state, env) {
    const _ctor0 = Date.now();
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    this.sockets = new Set();
    this.ready = false;
    // THIS ISOLATE, as distinct from this cell. Held in memory only, so it
    // changes exactly when the isolate is rebuilt and never otherwise. It is
    // the only evidence of an eviction a CALLER can obtain: celld 0.3.0 logs
    // no eviction line, and on the platform the node's logs are not reachable
    // from outside the microVM at all.
    this.instance = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    this.bornAt = Date.now();
    // A SESSION IS SEQUENTIAL, AND THE INPUT GATE DOES NOT MAKE IT SO.
    //
    // The Durable Object input gate is released across an await on anything that
    // is not storage (infra/celld/README.md), and a tool call is an await on
    // HTTP. So concurrent prompts to ONE cell interleave. Measured, before this
    // queue, with six concurrent prompts:
    //
    //   user:p2 user:p1 user:p3 user:p6 user:p5 user:p4
    //   assi:call2 tool:done2 assi:ok2  assi:call3 ...
    //
    // Every user message landed before any assistant message — not a
    // conversation, and worse, each buildAgent() had already read `messages`
    // from SQLite, so all six ran on a context missing each other's turns.
    //
    // blockConcurrencyWhile is the wrong tool: it would hold the gate across a
    // long HTTP call and stall reads too. A promise chain orders prompts
    // without blocking /history, which is what a transcript actually needs.
    this.tail = Promise.resolve();
    // What the isolate cost before it could answer anything. Reported by
    // /ping and /meter so the spawn budget is attributable rather than
    // inferred from a stopwatch on the far side of an ocean.
    this.ctorMs = Date.now() - _ctor0;
  }

  // Called at the top of every request. An isolate may be brand new even when
  // the cell is old, so this is idempotent and cheap rather than a constructor.
  init() {
    if (this.ready) return;
    const _init0 = Date.now();
    this.sql.exec(`CREATE TABLE IF NOT EXISTS msgs (
      i    INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      json TEXT NOT NULL,
      ts   INTEGER NOT NULL
    )`);
    // The op ledger. Deliberately NOT part of the transcript: it is the retry
    // record for tool calls, keyed by pi's toolCallId, and it has to survive
    // even when the turn that produced it never completed.
    // WHERE THE ACTIVE CONTEXT STARTS.
    //
    // Compaction used to DELETE the messages it summarised. That conflates two
    // different questions — what the model should be sent, and what actually
    // happened — and answers both by destroying the second. After a long
    // session /history showed a summary and a tail, and the record of what the
    // agent did was gone.
    //
    // The transcript is now kept and the context is a WINDOW over it.
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)");

    // WHAT THIS CELL OWES, counted where it happens.
    //
    // BILLED_UNITS_IMPLEMENTED in the control plane deliberately excludes
    // 'requests' because nothing counted them — and a cell is the one runtime
    // for which per-request is the only honest unit: it hibernates to nothing,
    // so charging it for RAM it is not holding bills a customer for storage
    // they already pay for separately.
    //
    // In the CELL's own SQLite rather than in memory, because the whole point
    // is that a cell is evicted and rebuilt constantly. A counter in the
    // instance would reset on every eviction, and eviction is not a rare event
    // — it is the normal way an idle cell exists.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meter (
      k     TEXT PRIMARY KEY,
      n     INTEGER NOT NULL DEFAULT 0
    )`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS ops (
      id         TEXT PRIMARY KEY,
      kind       TEXT,
      detail     TEXT,
      status     TEXT,
      out        TEXT,
      started_at INTEGER,
      ended_at   INTEGER,
      replayed   INTEGER DEFAULT 0,
      result     TEXT
    )`);
    // The tool result itself, kept so a retry can be ANSWERED rather than
    // re-run. `out` is the first 4000 characters for a human reading /ops;
    // `result` is what goes back to the model.
    try { this.sql.exec("ALTER TABLE ops ADD COLUMN result TEXT"); } catch { /* already there */ }
    // Added after the ops table shipped, so existing cells need it too. A cell
    // carries its SQLite across deployments; CREATE TABLE IF NOT EXISTS would
    // leave an old cell without the column and every ledger write would fail.
    try { this.sql.exec("ALTER TABLE ops ADD COLUMN replayed INTEGER DEFAULT 0"); } catch { /* already there */ }
    // WHAT THE SESSION ACTUALLY COST. Estimated tokens are a planning number;
    // this is the bill.
    //
    // Every assistant message carries the provider's own usage — input, output,
    // and crucially cacheRead/cacheWrite. pi applies prompt caching itself
    // (anthropic-messages sets cache_control; the Agent forwards sessionId for
    // cache-aware backends), so a long session is already paying ~10x less for
    // the repeated context than the input price suggests: claude-sonnet-5 is
    // $2.00/Mtok in against $0.20 cached, gpt-5.6-luna $0.20 against $0.02.
    //
    // None of that was visible. /context priced the whole transcript at the
    // full input rate every turn, which overstates the bill on any session long
    // enough to matter — and hides whether caching is working at all.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS usage (
      i           INTEGER PRIMARY KEY AUTOINCREMENT,
      turn        INTEGER,
      model       TEXT,
      input       INTEGER NOT NULL DEFAULT 0,
      output      INTEGER NOT NULL DEFAULT 0,
      cache_read  INTEGER NOT NULL DEFAULT 0,
      cache_write INTEGER NOT NULL DEFAULT 0,
      at          INTEGER NOT NULL
    )`);

    // THE TURN QUEUE. Durable, because a promise chain is not.
    //
    // Prompts were ordered by an in-memory promise chain, which works only while
    // the isolate lives and only while a caller holds the connection. Both
    // assumptions broke: celld 0.4.0 closes concurrent requests to one cell, and
    // an evicted isolate loses everything queued behind it.
    //
    // Rows plus an alarm survive both. The alarm handler is the only thing that
    // runs a turn, so ordering is a SELECT ... ORDER BY i LIMIT 1 rather than a
    // closure someone must keep alive.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS turns (
      i          INTEGER PRIMARY KEY AUTOINCREMENT,
      text       TEXT NOT NULL,
      script     TEXT,
      window     INTEGER,
      status     TEXT NOT NULL,
      error      TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      ended_at   INTEGER
    )`);
    // The wire id the control plane placed on the prompt, handed back when the
    // turn ends so the ledger closes the record it opened (relayTurnEnd).
    try { this.sql.exec("ALTER TABLE turns ADD COLUMN message_id TEXT"); } catch { /* already there */ }
    // WHICH SESSION THIS TURN IS FOR, taken from the prompt's own path.
    //
    // `KORTIX_SESSION_ID` cannot answer this on a SHARED cell host: it is the
    // NODE's env, set when the first session created the box, so every cell on
    // that node reads the same value. Measured on dev 2026-09-08 — three
    // sessions, one prompt each, all relaying turn_end under
    // b673ad47-4365-4ab4-951d-0b592f9b9423, which the control plane then pinned
    // as all three roots, and all three read one transcript.
    try { this.sql.exec("ALTER TABLE turns ADD COLUMN session_id TEXT"); } catch { /* already there */ }
    // THE SESSION'S OWN CONFIGURATION, WHICH MUST OUTLIVE THE ISOLATE.
    //
    // Per-session config does not arrive in the cell's process env — that is
    // the NODE's, shared by every cell on it — it is pushed over
    // POST /kortix/env. It used to be kept in `this.sessionEnv`, memory only,
    // and the comment there called it "a write, not a restart" while it was
    // neither: an eviction destroys the isolate and takes the whole map with
    // it. What comes back is a cell that no longer knows it is a platform
    // session, so `toolsFor` stops choosing the cell backend and the agent
    // loses its filesystem — measured 2026-09-08, session 0d4f60b5: before the
    // eviction `{"backend":"cell","files":3}`, after it no cell backend at all,
    // and the agent answered a request to read its own file by writing a
    // different one. The gateway URL and model go the same way, so the turn
    // after an eviction can also lose its model.
    //
    // It lives in the same SQLite as the transcript and the files, so it is
    // replicated to object storage and comes back with them. That includes the
    // session's Kortix token: the same store already holds the conversation,
    // and a session whose credential does not survive its own eviction cannot
    // finish the turn it was resumed for.
    // THE WIRE BUS, whose epoch is this isolate.
    //
    // `instance` changes when celld destroys and rebuilds the cell, which is
    // exactly when a cursor stops meaning anything — so the API is told to
    // drop it, by the same `epoch` field the reference daemon uses. Nothing
    // durable: a replay older than this boot is a resync, honestly.
    this.wire = this.wire ?? new WireBus({ epoch: this.instance });
    this.sql.exec("CREATE TABLE IF NOT EXISTS session_env (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    this.sessionEnv = this.sessionEnv ?? {};
    for (const row of this.sql.exec("SELECT k, v FROM session_env")) {
      this.sessionEnv[String(row.k)] = String(row.v);
    }
    // ONE PER ISOLATE. init() is guarded by this.ready, so this counts
    // constructions of the object, not requests — the epoch the local node
    // prints to its log, made durable so it can be read over HTTP from a
    // cell running on the platform. A fresh cell reads builds=1; a cell that
    // has been evicted and rebuilt once reads 2, and its `requests` meter
    // carries on from where it was rather than restarting.
    this.pending = this.pending ?? {};
    this.pending.builds = (this.pending.builds ?? 0) + 1;
    this.initMs = Date.now() - _init0;
    this.ready = true;
  }

  // Runs queued turns, one at a time, and reschedules while work remains.
  // THE SIGNAL THAT LETS THE NEXT PROMPT IN.
  //
  // The control plane opens a ledger record when it delivers a prompt and
  // admits the next inbox row only once that record closes. kortix-worker
  // closes it by POSTing `turn_end` to /projects/:id/turn-stream
  // (apps/kortix-worker/src/turn-end-relay.ts, the same body and bearer). A
  // cell that ran the turn and said nothing left the record `active` for its
  // whole grant. Measured on dev 2026-09-07, session b231c064: first prompt
  // answered in 9.0 s, second prompt `waiting / turn_active` for 240 s while
  // the cell sat idle with turn_in_flight:false.
  //
  // Awaited, not fire-and-forget: an alarm's un-awaited fetch may not outlive
  // the alarm. Bounded per attempt, so a slow control plane cannot hold the
  // queue either. Silent when the session carries no control-plane identity —
  // a bench or a local cell has nobody to tell.
  async relayTurnEnd(sessionId, turnI) {
    const env = this.effectiveEnv();
    const api = String(env.KORTIX_API_URL ?? "").replace(/\/+$/, "");
    const project = env.KORTIX_PROJECT_ID, token = env.KORTIX_TOKEN;
    if (!api || !project || !token) return;
    // The session the CONTROL PLANE knows, which is not always what the isolate
    // calls itself: an alarm has no request to read `?c=` from, so `sessionId`
    // there is the durable object's own name. KORTIX_SESSION_ID is the id the
    // ledger opened its record under, and `effectiveEnv` prefers the per-session
    // value pushed over POST /kortix/env to the node-wide one.
    const row = this.sql.exec("SELECT status, message_id, session_id FROM turns WHERE i=?", turnI).toArray()[0];
    // THE TURN'S OWN SESSION FIRST. `KORTIX_SESSION_ID` is the node's env and is
    // shared by every cell on a shared host, so preferring it made all of them
    // report the host-creating session (see the session_id column above).
    const sid = row?.session_id || env.KORTIX_SESSION_ID || sessionId;
    const body = JSON.stringify({
      session_id: sid, kind: "turn_end", status: row?.status === "done" ? "idle" : "error",
      opencode_session_id: sid,
      ...(row?.message_id ? { turn_message_id: row.message_id } : {}),
    });
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const res = await fetch(`${api}/projects/${encodeURIComponent(project)}/turn-stream`, {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body, signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) this.broadcast({ type: "turn_end_relay", turn: turnI, status: res.status });
        return;   // a non-ok answer is final, like the daemon's
      } catch (e) {
        if (attempt === 4) this.broadcast({ type: "turn_end_relay", turn: turnI, error: String(e?.message ?? e) });
        else await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }

  async alarm() {
    // The alarm is already paying for a durable write, so settling the tally
    // here is free — and it is what bounds the loss for a cell that goes quiet
    // mid-window and is then evicted.
    this.init();
    this.flushMeter();
    this.init();
    const sessionId = this.state.id?.toString?.() ?? "default";

    // A turn left 'running' means the cell died mid-turn. DO NOT re-run it.
    //
    // The op ledger protects a REPEATED tool call, but only because the id is
    // stable. Re-running a turn asks the model again, and the model mints NEW
    // toolCallIds — so every command would execute a second time with no
    // idempotency at all. Marking it interrupted keeps that decision with
    // whoever can actually make it.
    // Only turns from a PREVIOUS life: a turn claimed by a concurrent alarm in
    // this one is legitimately running. started_at older than this handler's
    // start is the discriminator.
    const bootAt = Date.now();
    this.sql.exec(
      `UPDATE turns SET status='interrupted', error='the cell died while this turn was running', ended_at=?
        WHERE status='running' AND (started_at IS NULL OR started_at < ?)`,
      bootAt, bootAt - 300_000,
    );

    // CLAIM ATOMICALLY. Two alarm invocations can overlap — measured: on celld
    // 0.3.0 six queued turns ran concurrently and produced the same interleaved
    // transcript the promise chain was added to prevent (0.4.0 serialises them,
    // so a SELECT-then-UPDATE looked correct there).
    //
    // A conditional UPDATE carrying a unique token is the claim: whoever's token
    // lands owns the turn, and everyone else reads back nothing and leaves.
    const token = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    // ONE TURN AT A TIME PER CELL, not one claimant per row.
    //
    // The first version guarded only against two alarms taking the SAME turn,
    // which is not the failure: six concurrent alarms each took a DIFFERENT
    // pending turn and ran them in parallel, producing exactly the interleaved
    // transcript this queue exists to prevent (all six user messages, then all
    // six turns).
    //
    // `NOT EXISTS (... status='running')` inside the same statement is the
    // serialisation. A single SQLite UPDATE is atomic with respect to other JS
    // here — the isolate is single-threaded and this call does not await — so
    // the check and the claim cannot be split by a concurrent alarm.
    this.sql.exec(
      `UPDATE turns SET status='running', started_at=?, error=?
        WHERE i = (SELECT MIN(i) FROM turns WHERE status='pending')
          AND status='pending'
          AND NOT EXISTS (SELECT 1 FROM turns WHERE status='running')`,
      Date.now(), token,
    );
    const next = this.sql.exec("SELECT * FROM turns WHERE status='running' AND error=?", token).toArray()[0];
    if (!next) return;   // another alarm claimed it
    // `error` was borrowed as the claim slot; clear it so a real failure is not
    // confused with a token.
    this.sql.exec("UPDATE turns SET error=NULL WHERE i=?", next.i);
    this.currentTurn = next.i;
    this.broadcast({ type: "turn_started", turn: next.i, text: String(next.text).slice(0, 120) });
    try {
      const script = next.script ? JSON.parse(next.script) : undefined;
      const { block } = await this.skills(sessionId);
      const agent = this.buildAgent(sessionId, script, withSkills(SYSTEM_PROMPT, block),
        this.wireSessionId(next, sessionId));
      // Held so /stop has something to abort. Without a reference to the
      // running agent there is no way to stop a turn at all: pi creates the
      // abort signal inside the run, and every cancellation the ExecutionEnv
      // and daemon can honour is unreachable from outside.
      this.running = { agent, turn: next.i, sessionId };
      // Where the transcript stood before this turn, so "did the model say
      // anything" is a question with an exact answer rather than a guess.
      const beforeMsgId = this.sql.exec("SELECT COALESCE(MAX(i), 0) AS i FROM msgs").toArray()[0].i;
      this.saveMessage("user", { role: "user", content: [{ type: "text", text: next.text }] });
      await agent.prompt(next.text);
      const compacted = await this.compactIfNeeded(sessionId, streamFnOf(agent), agent.state.model, next.window || undefined);
      if (compacted) this.broadcast({ type: "compacted", ...compacted });
      // A TURN THAT PRODUCED NOTHING IS NOT A SUCCESS, and saying `done` about
      // one is the most expensive lie this file can tell: the session shows an
      // empty reply, the control plane settles the turn, and every log says
      // fine. Measured on dev 2026-09-07: a live gateway, a resolved model, and
      // assistant messages with empty content and zero tokens, turn after turn,
      // with nothing anywhere naming a cause.
      //
      // The turn still ends — a stuck turn is worse — but it ends with a reason
      // attached, and the reason carries what would otherwise have to be
      // guessed: which model, which api, and whether a key and gateway were
      // even present.
      // CONTENT, not rows. An assistant row with an empty `content` array is
      // exactly what a failed model call leaves behind, so counting rows called
      // it a success — measured 2026-09-07, which is how this check passed on
      // its first outing while the reply was still blank.
      const produced = this.sql.exec(
        "SELECT COUNT(*) AS n FROM msgs WHERE role = 'assistant' AND i > ? AND json_array_length(json_extract(json, '$.content')) > 0",
        beforeMsgId,
      ).toArray()[0].n;
      if (produced === 0) {
        const e = normalizeModelEnv(this.effectiveEnv());
        const why = `the model produced nothing: model=${e.MODEL_ID ?? "unset"} api=${agent?.state?.model?.api ?? "?"} provider=${e.MODEL_PROVIDER ?? "unset"} gateway=${e.MODEL_BASE_URL ? "yes" : "no"} key=${e.MODEL_API_KEY ? "yes" : "no"}`;
        this.sql.exec("UPDATE turns SET status='error', error=?, ended_at=? WHERE i=?", why, Date.now(), next.i);
        this.broadcast({ type: "turn_error", turn: next.i, error: why });
      } else {
        this.sql.exec("UPDATE turns SET status='done', ended_at=? WHERE i=?", Date.now(), next.i);
        this.broadcast({ type: "turn_done", turn: next.i });
      }
    } catch (e) {
      this.sql.exec("UPDATE turns SET status='error', error=?, ended_at=? WHERE i=?",
        String(e?.message ?? e), Date.now(), next.i);
      this.broadcast({ type: "turn_error", turn: next.i, error: String(e?.message ?? e) });
    }
    await this.relayTurnEnd(sessionId, next.i);

    // Reschedule while anything is still pending. Immediate rather than delayed:
    // the queue is the only ordering mechanism, so a gap is latency for no gain.
    // Reschedule while anything is still pending. The alarm that finds another
    // turn running will simply leave, so an extra wake costs nothing.
    this.running = null;

    const more = this.sql.exec("SELECT COUNT(*) AS n FROM turns WHERE status='pending'").toArray()[0].n;
    if (more > 0) await this.state.storage.setAlarm(Date.now() + 1);
  }

  /** The first message id that is part of the active context. */
  contextFrom() {
    const rows = [...this.sql.exec("SELECT v FROM meta WHERE k='context_from'")];
    return rows.length ? Number(rows[0].v) : 0;
  }

  setContextFrom(i) {
    this.sql.exec("INSERT OR REPLACE INTO meta(k, v) VALUES ('context_from', ?)", String(i));
  }

  // THE ARCHIVE IS BOUNDED, because a cell's SQLite is not free.
  //
  // Keeping every message forever trades one problem for another: a long-lived
  // session would grow without limit in storage that is flushed to S3 on every
  // change. The newest archived messages are the ones worth keeping, so the
  // oldest are dropped once the archive passes its budget. Active-context
  // messages are never touched.
  pruneArchive(maxBytes = ARCHIVE_MAX_BYTES) {
    const from = this.contextFrom();
    if (from === 0) return 0;
    const rows = [...this.sql.exec("SELECT i, LENGTH(json) AS n FROM msgs WHERE i < ? ORDER BY i DESC", from)];
    let kept = 0, cutBelow = null;
    for (const r of rows) {
      kept += r.n;
      if (kept > maxBytes) { cutBelow = r.i; break; }
    }
    if (cutBelow === null) return 0;
    const dropped = this.sql.exec("SELECT COUNT(*) AS n FROM msgs WHERE i <= ?", cutBelow).toArray()[0].n;
    this.sql.exec("DELETE FROM msgs WHERE i <= ?", cutBelow);
    return dropped;
  }

  loadMessages() {
    // The WINDOW, not the archive. Everything before context_from has been
    // summarised and stays on disk for /history and for audit.
    return [...this.sql.exec("SELECT json FROM msgs WHERE i >= ? ORDER BY i", this.contextFrom())]
      .map((r) => JSON.parse(r.json));
  }

  saveMessage(role, message) {
    this.sql.exec(
      "INSERT INTO msgs(role, json, ts) VALUES (?, ?, ?)",
      role, JSON.stringify(message), Date.now(),
    );
  }

  // BROADCAST THROUGH THE RUNTIME, not a field.
  //
  // `this.sockets` was a Set on the instance, so it emptied on every eviction —
  // and with turns now running in an alarm, the socket is the only way a client
  // sees progress at all. state.getWebSockets() returns the sockets the RUNTIME
  // is holding, including ones accepted by an isolate that no longer exists.
  //
  // That is also what makes the capacity arithmetic work: a hibernated socket
  // costs the node a file descriptor, not a live isolate.
  /**
   * THE EVENT STREAM THE PRODUCT READS.
   *
   * kortix-worker serves /events as SSE and pushes every pi agent event into
   * it (`data: <event>\n\n`). A cell had only a WebSocket, so a UI that speaks
   * the harness's contract saw NOTHING until the turn was over — the answer
   * appeared all at once at the end instead of arriving.
   *
   * That is the whole difference between a 5 s wait and a 2.6 s first token:
   * measured against this gateway, first content lands at 2.6-5.9 s while a
   * turn completes at 5.1-7.6 s. Everything between those two numbers is time
   * the user spent looking at nothing.
   */
  sse(event) {
    const set = this.sseListeners;
    if (!set || set.size === 0) return;
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const w of [...set]) {
      try { w.write(line); } catch { set.delete(w); }
    }
  }

  /**
   * `mirror: false` when the SSE stream has already had the real thing.
   *
   * A WebSocket watcher gets a bare `{type}` notification for every agent
   * event; an SSE client gets the event itself, verbatim, because that is the
   * harness's contract. Mirroring the notification too delivered EVERY event
   * twice — measured on dev 2026-09-07 against a live stream: `agent_start`,
   * `turn_start`, `message_start` and `message_end` each arrived once as
   * themselves and once as a stub, and a consumer that renders what it is sent
   * would render the turn twice.
   */
  /**
   * The id of the assistant message currently being streamed.
   *
   * ZERO-PADDED and monotonic because the ORDER is load-bearing: the transcript
   * sorts by it, and "has this prompt been answered" is decided by comparing
   * the newest assistant id to the user's. `msg-2` sorting before `msg-10` is
   * how an answered turn reads as unanswered.
   */
  /**
   * THE SESSION NAME THE PRODUCT KNOWS, resolved from a turn that is running
   * without a request.
   *
   * Turns run in `alarm()`, and an alarm has no `?c=` and no path — so
   * `sessionId` there is `this.state.id.toString()`, celld's own 64-hex object
   * id. Every wire frame built from it named a session no client has ever
   * heard of: measured on dev 2026-09-09, 117 `message.part.delta` frames
   * reached the browser carrying
   * `"sessionID":"5e46f994978d338d8fa19d95836d6279…"` while the session was
   * 69658df3-b530-410f-b5d6-2f89822f00c9. A reducer that keys parts by session
   * drops every one of them, and the answer still does not paint.
   *
   * Same order `relayTurnEnd` already uses, and for the same reason: the
   * TURN's own session first, because `KORTIX_SESSION_ID` is the node's env
   * and names the session that created a shared host.
   */
  wireSessionId(turnRow, fallback) {
    return turnRow?.session_id || this.effectiveEnv().KORTIX_SESSION_ID || fallback;
  }

  mintWireMessageId() {
    this.wireMessageSeq = (this.wireMessageSeq ?? 0) + 1;
    return `msg_cell_${String(this.wireMessageSeq).padStart(8, "0")}`;
  }

  broadcast(event, { mirror = true } = {}) {
    if (mirror) this.sse({ ...event, at: Date.now() });
    const payload = JSON.stringify({ ...event, at: Date.now() });
    // THE UNION, not either one. Measured on celld 0.3.0, 2026-09-02: after a
    // cell is evicted and rebuilt, getWebSockets() returns 0 for a watcher that
    // is still connected — but an inbound message from that same socket IS
    // delivered to the new instance and can be replied to. The socket is not
    // orphaned, it is half-connected: the client can talk, the server cannot
    // push. Re-registering it on its first message (see webSocketMessage) and
    // unioning here is what closes that gap.
    const seen = new Set(this.state.getWebSockets?.() ?? []);
    for (const ws of this.sockets) seen.add(ws);
    const sockets = [...seen];
    for (const ws of sockets) {
      try { ws.send(payload); } catch { /* closing; the runtime will drop it */ }
    }
  }

  // A fresh Agent per request, seeded from storage. This looks wasteful and is
  // the point: it is the same path a COLD cell takes, so the resume path is
  // exercised by every single request instead of only after an eviction.
  // `script` overrides env.SCRIPT for one call. Only the scripted model reads it,
  // so it is a test affordance and not a way to steer a real model: with an API
  // key present the argument is ignored entirely.
  // THE WORKSPACE'S SKILLS, LOADED ONCE PER LIVE CELL.
  //
  // Loading walks the skills directory: 19 round trips for two skills. Per turn
  // that is a few hundred milliseconds of latency buying nothing, because the
  // workspace rarely changes underneath a session. Held in memory rather than
  // SQLite deliberately — an evicted cell rebuilds it on wake, which is also
  // how a skill added since the cell started gets picked up.
  async skills(sessionId, { reload = false } = {}) {
    // KEYED BY SESSION, because the daemon roots each session at its own
    // workspace directory. Loading them under a fixed id read skills from a
    // directory no session works in — the agent's own `.pi/skills` was
    // invisible, and the suite passed only because its fixture was written to
    // that other path.
    this.skillsCache ??= new Map();
    if (this.skillsCache.has(sessionId) && !reload) return this.skillsCache.get(sessionId);
    const loaded = await loadWorkspaceSkills(
      this.effectiveEnv(),
      (opId) => executionEnvFor(this.effectiveEnv(), sessionId, opId),
    );
    this.skillsCache.set(sessionId, loaded);
    return loaded;
  }

  buildAgent(sessionId, script, systemPrompt = SYSTEM_PROMPT, wireSessionId = sessionId) {
    const configured = modelConfig(this.effectiveEnv());
    const streamFn = configured
      ? configured.streamFn
      : scriptedStream(script ?? JSON.parse(this.effectiveEnv().SCRIPT ?? "[]"));

    // Tools FIRST, because what the shell is decides what the prompt must say.
    // toolsFor is what creates this.cellFs, so the note can only be written
    // after it has run — and only for the backend it describes: a session with
    // a Platinum workspace has a real Linux box and must not be told otherwise.
    const tools = toolsFor(this.effectiveEnv(), sessionId, this.sql, this);
    const note = this.cellFs ? cellShellNote() : "";
    const agent = new Agent({
      streamFn,
      sessionId,
      getApiKey: configured?.getApiKey,
      initialState: {
        systemPrompt: note ? `${systemPrompt}\n\n${note}` : systemPrompt,
        model: configured?.model ?? SCRIPTED_MODEL,
        tools,
        messages: this.loadMessages(),
      },
    });

    // ONE ADAPTER PER AGENT, because it is stateful across a turn: part ids,
    // the accumulated text of each part, and which assistant message is open.
    // Sharing one across turns would collide their part ids; making one per
    // EVENT would restart the accumulation on every delta.
    const wireAdapter = new ChatEventAdapter({
      sessionID: wireSessionId,
      mintMessageId: () => this.mintWireMessageId(),
    });

    agent.subscribe((event) => {
      // RAW, FIRST. The harness pushes every agent event onto /events verbatim,
      // and a consumer written against it expects the same shapes — deltas
      // included, which is what makes an answer arrive rather than appear.
      this.sse(event);
      // AND THE SAME EVENT IN THE SHAPE THE PRODUCT READS. The web client's
      // reducer applies OpenCode wire events and repaints incrementally only
      // from `message.part.delta`; pi's own event names mean nothing to it.
      // Translated by kortix-worker's adapter rather than a second copy of the
      // mapping — it is the one the UI was written against, and its own tests
      // pin the delta/snapshot split this bus depends on.
      try { this.wire?.publish(wireAdapter.translate(event)); } catch { /* never break a turn to publish it */ }
      // Stream what a watcher actually needs: which tool is running, and what
      // came back. Previously this sent only `{type}`, which tells a UI that
      // something happened and nothing about what.
      if (event.type === "tool_execution_start") {
        this.broadcast({ type: "tool_start", tool: event.toolName ?? event.tool?.name, id: event.toolCallId });
      }
      if (event.type === "tool_execution_end") {
        const text = (event.result?.content ?? []).find((b) => b?.type === "text")?.text;
        this.broadcast({ type: "tool_end", id: event.toolCallId, output: typeof text === "string" ? text.slice(0, 400) : undefined });
      }
      // turn_end carries the assistant message AND that turn's tool results
      // together, which is the only point where the transcript is consistent:
      // persisting the assistant message alone would leave a tool call with no
      // result if the isolate died in between, and pi would resend it.
      if (event.type === "turn_end") {
        if (event.message) this.saveMessage("assistant", event.message);
        // Recorded from the message the provider actually returned, not from an
        // estimate. A turn with no usage (the scripted model) writes nothing
        // rather than a row of zeros that would dilute the averages.
        const u = event.message?.usage;
        if (u && (u.input || u.output || u.cacheRead || u.cacheWrite)) {
          this.sql.exec(
            "INSERT INTO usage(turn, model, input, output, cache_read, cache_write, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            this.currentTurn ?? null, event.message.model ?? null,
            u.input ?? 0, u.output ?? 0, u.cacheRead ?? 0, u.cacheWrite ?? 0, Date.now(),
          );
        }
        for (const r of event.toolResults ?? []) this.saveMessage("toolResult", r);
      }
      if (event.type !== "tool_execution_start" && event.type !== "tool_execution_end") {
        // Sockets only: the SSE stream already carried this event in full,
        // above, and sending the stub after it delivers everything twice.
        this.broadcast({ type: event.type }, { mirror: false });
      }
    });

    // The Agent does not expose its stream function, and compaction needs the
    // same one so a summary is produced by the session's own model.
    agent.__streamFn = streamFn;
    return agent;
  }

  // COMPACT AFTER A TURN, not before: the turn that just ran is the one whose
  // cost we now know, and compacting first would summarise a conversation the
  // user is still mid-way through.
  //
  // The summary is produced by the same streamFn the agent uses, so it works
  // with the scripted model and costs nothing in tests.
  // The context window comes from pi's model catalogue — 400k for gpt-5.1, 1M
  // for claude-sonnet-5, 272k for gpt-5.6-luna — so the compaction threshold is
  // per-model and correct without a table of our own. CONTEXT_WINDOW overrides
  // it, which is how a test triggers compaction without generating 200k tokens.
  contextWindowFor(model, perRequest) {
    // Per-request first, so a test can reach compaction WITHOUT restarting the
    // node. That matters beyond convenience: restarting a working celld
    // container repeatedly is what kept killing the local Docker VM, and a
    // claim that needs a restart to set one number is a claim that makes the
    // suite less likely to finish.
    const n = Number(perRequest ?? 0);
    if (n > 0) return n;
    const override = Number(this.effectiveEnv().CONTEXT_WINDOW ?? 0);
    return override > 0 ? override : (model?.contextWindow ?? 200_000);
  }

  async compactIfNeeded(sessionId, streamFn, model, perRequestWindow) {
    const messages = this.loadMessages();
    const window = this.contextWindowFor(model, perRequestWindow);
    const result = await maybeCompact({
      messages,
      contextWindow: window,
      summarise: async (older) => {
        const stream = await streamFn(model, {
          systemPrompt: SUMMARY_PROMPT,
          messages: older,
          tools: [],
        });
        const final = await stream.result();
        return (final.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n") || "(no summary)";
      },
    });
    if (!result) return null;
    // Replace the transcript in ONE transaction-shaped sequence. A crash between
    // the delete and the insert would lose the conversation outright, so the new
    // rows are written first and the old ones removed by id afterwards.
    const lastArchived = this.sql.exec("SELECT COALESCE(MAX(i), 0) AS m FROM msgs").toArray()[0].m;
    // Persist each message under ITS OWN role. A compaction summary is
    // role "compactionSummary" — flattening it to "assistant" would store a
    // message with no content blocks as an assistant turn, and the next load
    // would hand the model something it cannot read.
    for (const m of result.messages) this.saveMessage(m.role, m);
    // The summarised messages are ARCHIVED, not deleted: the context moves past
    // them. A cell that threw them away could not answer "what did the agent
    // do?" for anything older than the last compaction.
    this.setContextFrom(lastArchived + 1);
    this.pruneArchive();
    return result;
  }

  // Hibernation handlers. Their existence is what lets the runtime evict the
  // isolate while keeping the socket: it re-creates the object and calls these.
  async webSocketMessage(ws, message) {
    this.init();
    // Re-adopt a socket the runtime did not hand back.
    //
    // This does NOT rescue a socket that predates an eviction on celld 0.3.0,
    // and it was written believing it would. Measured 2026-09-02: after an
    // eviction the ping IS answered, but `readopted` stays 0 on the instance
    // that serves the next request — celld hands the message to a transient
    // instance whose in-memory state does not persist. There is no way for a
    // rebuilt cell to push to a socket opened before it; the client must
    // reconnect.
    //
    // Kept because it is correct and free on a runtime that DOES hand sockets
    // back, and because `broadcast` unions both sources either way.
    this.sockets.add(ws);
    // The protocol is deliberately tiny. A socket is for WATCHING a session;
    // prompts go through POST /prompt, which is durable, ordered and auditable.
    // Accepting work here would be a second, unqueued way in.
    let msg = {};
    try { msg = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message)); } catch { /* ignore */ }
    if (msg.type === "status") {
      ws.send(JSON.stringify({
        type: "status",
        // The CONTEXT's message count, to match the token figure beside it.
        // These disagreed once the archive stopped being deleted: `tokens`
        // described the window and `messages` counted the whole table, so the
        // one number on this endpoint that says "how big is the context" was
        // the one that was wrong.
        messages: this.sql.exec("SELECT COUNT(*) AS n FROM msgs WHERE i >= ?", this.contextFrom()).toArray()[0].n,
        archived: this.sql.exec("SELECT COUNT(*) AS n FROM msgs WHERE i < ?", this.contextFrom()).toArray()[0].n,
        turns: [...this.sql.exec("SELECT i, status FROM turns ORDER BY i DESC LIMIT 5")],
        at: Date.now(),
      }));
    }
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch { /* already gone */ }
  }

  /**
   * THE ENVIRONMENT THIS SESSION ACTUALLY RUNS WITH.
   *
   * A cell's `env` is the NODE's, not the session's. celld hands every
   * CELLD_VAR_X on the node process to the worker as env.X — and a celld node
   * hosts many cells, so anything set that way is identical for all of them.
   * Infrastructure belongs there (PT_S3_*, set by the host agent); a session's
   * configuration cannot, because its token, its gateway, its store URL and its
   * own id differ for every cell on the node.
   *
   * The control plane already knows this and pushes a session's environment
   * over HTTP once the box is up — that is what POST /kortix/env is, and what
   * the API's `env-sync` step does (632 ms in a proxy timeline, dev
   * 2026-09-07). This cell STORED that and then read the node's env anyway, so
   * a real session arrived fully configured and ran with none of it. Measured
   * the same day, session ccaea567: the isolate's env held AGENT, MODEL_*,
   * SCRIPT, TOOL_DAEMON_URL and PT_S3_* — not one KORTIX_* name — while the
   * sandbox carried fourteen of them.
   *
   * Session values win: they are the specific ones, and the node's are the
   * defaults a bench or a suite sets.
   */
  effectiveEnv() {
    const session = this.sessionEnv;
    if (!session || Object.keys(session).length === 0) return this.env ?? {};
    return { ...(this.env ?? {}), ...session };
  }

  /** Bump a meter. One statement, so a concurrent request cannot lose a count. */
  meter(key, by = 1) {
    this.sql.exec(
      "INSERT INTO meter(k, n) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET n = n + ?",
      key, by, by,
    );
  }

  /**
   * A DURABLE WRITE IS THE WHOLE COST OF A REQUEST HERE.
   *
   * celld makes a SQLite write durable in object storage before it lets the
   * response out — that is the guarantee, not a bug. Measured on dev
   * 2026-09-07 against one warm cell: entering the cell cost 2 ms, a SQLite
   * READ 3 ms, and a single durable WRITE 154 ms. So counting requests on the
   * request path made every billable call an object-storage round trip, and
   * the counter was the only reason most of them wrote anything at all.
   *
   * The count is now kept in the instance and flushed in one statement. It is
   * still EXACT wherever anyone looks: /meter flushes before it reports, and
   * the alarm flushes whatever a turn left behind. What a rebuild can lose is
   * bounded by the threshold and only covers requests nobody ever read back —
   * which is the trade a 154 ms floor per request is worth.
   */
  meterRequest() {
    this.pending = this.pending ?? {};
    this.pending.requests = (this.pending.requests ?? 0) + 1;
    if (this.pending.requests >= REQUEST_FLUSH_EVERY) this.flushMeter();
  }

  /**
   * Settle the in-memory tally. One statement per key, and a no-op when
   * nothing is owed.
   *
   * `builds` rides the same path. It is written once per isolate and it used
   * to be written inside init(), which put a durable write on the FIRST
   * request every fresh isolate served — the single most expensive request a
   * session makes. Measured on dev 2026-09-07: a cold isolate cost 362 ms over
   * the wire with that write and 178 ms of that was the wire itself. Deferring
   * it costs nothing that matters, because every reader of `builds` goes
   * through /meter, which settles before it reports.
   */
  flushMeter() {
    const p = this.pending ?? {};
    let wrote = 0;
    for (const [k, n] of Object.entries(p)) {
      if (!n) continue;
      this.meter(k, n);
      wrote += n;
    }
    this.pending = {};
    return wrote;
  }

  /**
   * THE CELL'S OWN CLOCK, on every answer.
   *
   * A caller timing a request to a cell measures four things at once: opening
   * a connection, the hop, this isolate's work, and the hop back. When the
   * number is wrong there is no way to tell which — and a whole tick went into
   * guessing. Measured 2026-09-09, the API's env repair reported `post: 73 ms`
   * to a box whose same POST answered in 9 ms p50 from a warm connection in
   * another process, and nothing on either side said where the other 64 ms
   * went.
   *
   * `x-cell-ms` is the part this isolate is responsible for. Subtracting it
   * from the caller's own measurement leaves the network, which is the only
   * other place the time can be. One header, every route, no new endpoint to
   * remember to call.
   *
   * Deliberately NOT `Server-Timing`: that is a browser-facing format with a
   * parser, and this is read by a log line and a shell script.
   */
  async fetch(req) {
    const cellT0 = performance.now();
    const res = await this.handle(req);
    try {
      res.headers.set("x-cell-ms", (performance.now() - cellT0).toFixed(1));
    } catch { /* a response whose headers are sealed still answers */ }
    return res;
  }

  async handle(req) {
    // BEFORE init(), DELIBERATELY. /ping is the only path that reaches a cell
    // without paying for its schema, which is what makes the two halves of a
    // cold start separable: everything up to here is celld creating the
    // isolate and evaluating the script, and the gap between /ping and any
    // other path is this worker's own start-up.
    //
    // Measured on dev 2026-09-07 against agentOS's 4.8 ms in-process spawn —
    // see the numbers in test/spawn-budget.mjs.
    if (new URL(req.url).pathname === "/ping") {
      return Response.json({
        instance: this.instance,
        ctorMs: this.ctorMs ?? null,
        initMs: this.initMs ?? null,     // null until something has run init()
        ready: this.ready,
        ageMs: Date.now() - this.bornAt,
        // WHAT THIS ISOLATE CAN SEE, by NAME only — never a value. Twice now a
        // session has arrived correctly configured and behaved as if it had
        // not, and the only way to tell "the platform did not send it" from
        // "the cell did not read it" was to guess. A cell's env comes from
        // CELLD_VAR_* on the sandbox, and whether the prefix survives into the
        // isolate is exactly the kind of thing that is easier to read than to
        // reason about.
        envKeys: Object.keys(this.env ?? {}).sort(),
      });
    }
    this.init();
    const url = new URL(req.url);
    const pathSession = url.pathname.match(/^\/session\/([^/]+)(?:\/|$)/);

    // ADDRESSING IS NOT ROUTING, and conflating the two cost this worker every
    // route it has except three.
    //
    // The API's sandbox proxy forwards the path and DROPS the query, so
    // `/session/<id>/…` is the only way the product can name one session's
    // isolate on a box that holds several. Every route below was written as an
    // exact pathname, so under that form all of them missed and fell through to
    // the catch-all — which answered 200 to anything. Measured on dev
    // 2026-09-09 against sbx_01M21XGVJNB5TZE6SV8MRC8FMW, same isolate, same
    // route, addressed the two ways:
    //
    //   GET /model?c=<session>        {"tools":{"backend":"cell","cwd":"/work"…
    //   GET /session/<session>/model  {"ok":true,"sessionId":…,"messages":4}
    //
    // One of those two answers is a shrug wearing a 200, and it is the one the
    // product gets. The prefix says WHICH cell; it must not decide WHICH route.
    // Strip it once, here, and route on what is left. A bare `/session/<id>` is
    // a question about the session itself, which is what `/session` answers.
    const path = pathSession
      ? (url.pathname.slice(pathSession[0].replace(/\/$/, "").length) || "/session")
      : url.pathname;

    // NOT EVERY REQUEST IS BILLABLE, and getting this wrong is not a rounding
    // error. /meter and /health are what a monitor polls; counting them would
    // let an operator's dashboard invent a customer's bill, and the customer
    // could not see why. Excluded by an explicit list rather than by a prefix
    // convention, so adding an endpoint is a decision about billing rather than
    // an accident of its name.
    if (!UNBILLED_PATHS.has(path)) this.meterRequest();
    const sessionId = url.searchParams.get("c")
      ?? (pathSession ? decodeURIComponent(pathSession[1]) : null)
      ?? this.effectiveEnv().KORTIX_SESSION_ID
      ?? this.state.id?.toString?.()
      ?? "default";

    if (req.headers.get("upgrade") === "websocket") {
      const pair = new WebSocketPair();
      // acceptWebSocket, NOT accept(): the first hands the socket to the runtime
      // so it survives the isolate being evicted, which is the whole reason a
      // parked session costs a file descriptor instead of memory. accept() keeps
      // it on this instance and loses it on eviction.
      if (typeof this.state.acceptWebSocket === "function") {
        this.state.acceptWebSocket(pair[1], [sessionId]);
        // Answer keepalives in the runtime so a ping does not wake the isolate.
        // A parked session that is woken every 30 s by a heartbeat is not parked.
        this.state.setWebSocketAutoResponse?.(new WebSocketRequestResponsePair("ping", "pong"));
      } else {
        pair[1].accept();
        this.sockets.add(pair[1]);
      }
      // Send the current state immediately: a client that connects mid-turn
      // should not have to wait for the next event to know where things stand.
      try {
        pair[1].send(JSON.stringify({
          type: "hello",
          sessionId,
          // The CONTEXT's message count, to match the token figure beside it.
        // These disagreed once the archive stopped being deleted: `tokens`
        // described the window and `messages` counted the whole table, so the
        // one number on this endpoint that says "how big is the context" was
        // the one that was wrong.
        messages: this.sql.exec("SELECT COUNT(*) AS n FROM msgs WHERE i >= ?", this.contextFrom()).toArray()[0].n,
        archived: this.sql.exec("SELECT COUNT(*) AS n FROM msgs WHERE i < ?", this.contextFrom()).toArray()[0].n,
          pending: this.sql.exec("SELECT COUNT(*) AS n FROM turns WHERE status IN ('pending','running')").toArray()[0].n,
          at: Date.now(),
        }));
      } catch { /* client vanished between upgrade and first write */ }
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // STOP THE RUNNING TURN.
    //
    // The whole cancellation path — pi's abortSignal, the env's /cancel, the
    // daemon killing the process group — is unreachable without this: pi
    // creates the signal inside the run, so something has to call abort() from
    // outside. Nothing did, which made a runaway command unstoppable for its
    // full timeout however well the layers beneath it behaved.
    //
    // `?queue=1` also drops what has not started. Off by default: stopping the
    // command someone is watching is a different intent from discarding work
    // they queued.
    // ── THE KORTIX SESSION SURFACE ────────────────────────────────────────
    //
    // A Kortix session drives a worker over a fixed set of paths (see
    // apps/kortix-worker/src/main.ts): /kortix/health, /kortix/env,
    // /kortix/refresh, /events, /interrupt, /turn, /session. This cell already
    // does every one of those things under its own names, so parity is a
    // mapping, not a second engine — and the mapping lives here rather than in
    // the API so a cell stays drivable by anything that speaks the session
    // protocol.
    //
    // Deliberately NOT aliases in a table: each one answers in the shape the
    // session expects, which is not always the shape this cell returns.
    if (path === "/kortix/health") {
      // THE FIELDS THE SESSION ACTUALLY READS, not the ones a cell would
      // naturally report. Kortix classifies a box from this body
      // (apps/api/src/projects/lib/legacy-runtime-bootstrap.ts): `daemon` must
      // be the string "ok" or the box is `not-ok`, and `runtime` must be an
      // OBJECT or the box is `legacy` and gets put through a convergence path
      // a cell has no use for.
      //
      // This used to answer `{ok, agent, sessionId, runtime: "ready", ...}`.
      // Every field of that is true and none of it is what is read: `ok` is not
      // `daemon`, and `runtime` as a STRING is not a runtime block. Measured on
      // dev 2026-09-06, session 708ea3ca: the cell answered /kortix/health 200
      // with runtime "ready" throughout while the session sat in
      // `open-session:starting` for 181 s and never opened.
      //
      // The shape is kortix-worker's (apps/kortix-worker/src/worker.ts), because
      // that is the contract the session speaks and parity with it is the point.
      const turns = this.sql.exec("SELECT COUNT(*) AS n FROM turns").toArray()[0].n;
      // THE TURN PROBE, which is what releases the NEXT prompt.
      //
      // A queued prompt is held while the session holds turn authority, and the
      // control plane settles that by polling /kortix/health?turn=1 and reading
      // `turn_in_flight` (readSandboxTurn in apps/api/src/projects/reaping/
      // box-reaper.ts). A body without the field reads as "this build says
      // nothing about turns", the marker is never cleared, and every prompt
      // after the first waits for ever on `turn_active`.
      //
      // Measured on dev 2026-09-07, session dee5338a: the session reached
      // `ready`, the prompt was accepted 202, and it sat in state `waiting`
      // reason `turn_active` with attempts=0 — the delivery loop never tried,
      // because nothing ever told it the turn was over.
      const probe = url.searchParams.get("turn") === "1"
        ? (() => {
            const pending = this.sql.exec(
              "SELECT COUNT(*) AS n FROM turns WHERE status IN ('pending','running')",
            ).toArray()[0].n;
            const inFlight = !!this.running || pending > 0;
            const last = this.sql.exec(
              "SELECT status, error FROM turns ORDER BY i DESC LIMIT 1",
            ).toArray()[0] ?? null;
            return {
              turn_in_flight: inFlight,
              // Only meaningful when nothing is in flight; the reader ignores
              // it otherwise.
              turn_end: inFlight ? null : (last?.status === "error" ? "error" : "completed"),
              // A prompt this cell accepted and never ran. `pending` with no
              // running turn and no alarm progress is exactly that.
              turn_orphaned_prompt: !this.running && pending > 0,
            };
          })()
        : null;
      return Response.json({
        ...(probe ?? {}),
        daemon: "ok",
        status: "ok",
        runtimeReady: true,
        workload: "session",
        // A cell runs no OpenCode. The session must not wait for one, so this
        // says the component it asks after is fine rather than absent.
        opencode: "ok",
        engine: "pi",
        uptime_s: Math.floor((Date.now() - this.bornAt) / 1000),
        repo_required: false,
        repo_ready: true,
        boot_error: null,
        store_error: null,
        model_mode: normalizeModelEnv(this.effectiveEnv()).MODEL_API_KEY ? "live" : "scripted",
        model_error: null,
        opencode_session_id: sessionId,
        opencode_session_required: false,
        agent_config_etag: null,
        commit_sha: null,
        branch: null,
        runtime: { build: null, at: null, components: {}, agentSwapPending: false, pinned: false },
        // The cell's own facts, kept alongside rather than instead of the
        // contract: a caller that knows about cells can still use them.
        ok: true,
        agent: "pi-in-a-cell",
        sessionId,
        busy: !!this.running,
        turns,
        instance: this.instance,
      });
    }
    // Env sync. The session pushes the environment a turn must run with; a cell
    // keeps it per session, so this is a write, not a restart.
    if (path === "/kortix/env" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const incoming = (body && typeof body === "object" && body.env && typeof body.env === "object") ? body.env : body;
      const applied = [];
      for (const [k, v] of Object.entries(incoming ?? {})) {
        if (typeof k !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
        this.sessionEnv = this.sessionEnv ?? {};
        this.sessionEnv[k] = String(v);
        this.sql.exec("INSERT INTO session_env(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, String(v));
        applied.push(k);
      }
      return Response.json({ ok: true, sessionId, applied: applied.length, keys: applied.slice(0, 40) });
    }
    if (path === "/kortix/env") {
      return Response.json({ ok: true, sessionId, keys: Object.keys(this.sessionEnv ?? {}) });
    }
    // Refresh: a session asks a worker to re-read what it can re-read. For a
    // cell that is its skills; nothing else here is cached across a turn.
    if (path === "/kortix/refresh" && req.method === "POST") {
      const { skills, diagnostics } = await this.skills(sessionId, { reload: true });
      return Response.json({ ok: true, sessionId, skills: skills.length, diagnostics });
    }
    // The session's own stop verb.
    if (path === "/interrupt" && req.method === "POST") {
      const running = this.running;
      if (!running) return Response.json({ stopped: false, reason: "no turn is running" });
      running.agent.abort();
      return Response.json({ stopped: true, turn: running.turn });
    }
    // One turn's state, the way a session asks for it: the newest turn, and
    // whether anything is running right now.
    if (path === "/turn") {
      // `i` is the turn id everywhere else in this file (this.running.turn is
      // set from it); there is no `turn` column.
      const rows = [...this.sql.exec("SELECT i, status, error FROM turns ORDER BY i DESC LIMIT 1")];
      const last = rows[0] ?? null;
      return Response.json({
        sessionId,
        running: !!this.running,
        turn: this.running ? this.running.turn : (last ? last.i : null),
        status: this.running ? "running" : (last ? last.status : "idle"),
        error: last?.error ?? null,
      });
    }
    // GET /session IS A LIST, BECAUSE THAT IS WHAT THE CONTROL PLANE PROBES.
    //
    // A session does not reach `ready` on the strength of /kortix/health. The
    // start path calls ensureOpencodeSessionPin, which GETs
    // `/session?directory=…`, expects an ARRAY of OpenCode-shaped sessions, and
    // pins the canonical root — the most recently active entry with no
    // `parentID` (apps/api/src/projects/opencode-session-resolver.ts). No array,
    // no root, and the answer is `not_ready`, which the envelope reports as
    // runtime `booting` forever.
    //
    // This returned a cell-shaped OBJECT. Measured on dev 2026-09-07, session
    // 6102257c: the cell answered /kortix/health with runtimeReady true and
    // daemon ok the whole time, and the session still ended
    // `runtime_not_ready_timeout` with observation runtime.state "booting",
    // because the pin could never resolve.
    //
    // The shape is kortix-worker's (opencodeSessionObject in
    // apps/kortix-worker/src/runtime-surface.ts): one root, no parent. The
    // cell's own facts ride along as extra keys, which the resolver ignores and
    // a cell-aware caller can still read.
    if (path === "/session") {
      const msgs = this.sql.exec("SELECT COUNT(*) AS n FROM msgs").toArray()[0].n;
      const turns = this.sql.exec("SELECT COUNT(*) AS n FROM turns").toArray()[0].n;
      const t = this.sql.exec("SELECT MIN(ts) AS a, MAX(ts) AS b FROM msgs").toArray()[0] ?? {};
      const created = t.a ?? this.bornAt;
      const updated = t.b ?? created;
      return Response.json([{
        id: sessionId,
        title: sessionId,
        // No parentID: this cell IS the root. A parent would make it
        // unpickable and the session would never leave `booting`.
        parentID: null,
        directory: this.effectiveEnv().PT_WORKSPACE_CWD ?? "/workspace",
        time: { created, updated },
        version: "pi",
        // The cell's own document, alongside rather than instead of it.
        sessionId,
        agent: "pi-in-a-cell",
        busy: !!this.running,
        messages: msgs,
        turns,
        contextFrom: this.contextFrom(),
      }]);
    }
    if (path === "/stop" && req.method === "POST") {
      const running = this.running;
      let dropped = 0;
      if (url.searchParams.get("queue") === "1") {
        dropped = this.sql.exec("SELECT COUNT(*) AS n FROM turns WHERE status='pending'").toArray()[0].n;
        this.sql.exec("UPDATE turns SET status='error', error='dropped by /stop' WHERE status='pending'");
      }
      if (!running) return Response.json({ stopped: false, reason: "no turn is running", dropped });
      running.agent.abort();
      return Response.json({ stopped: true, turn: running.turn, dropped });
    }

    // WHAT SKILLS THIS CELL CAN SEE, and why one is missing.
    //
    // A skill with broken frontmatter is skipped with a diagnostic, and without
    // a way to read those the only symptom is a model that never uses a skill
    // somebody swears they wrote. `?reload=1` re-reads the workspace, which
    // matters because the agent can WRITE skills into it.
    if (path === "/skills") {
      const reload = url.searchParams.get("reload") === "1";
      const { skills, diagnostics, dirs } = await this.skills(sessionId, { reload });
      return Response.json({
        dirs,
        skills: skills.map((sk) => ({ name: sk.name, description: sk.description, path: sk.filePath, bytes: sk.content.length })),
        diagnostics,
      });
    }

    // THE ROUTE THE PRODUCT ACTUALLY DELIVERS PROMPTS ON.
    //
    // The session lifecycle sends every composer message and every queued
    // prompt to POST /session/:rootId/prompt_async — not to this cell's own
    // /prompt (apps/api engine.ts postPrompt, and the comment that names it in
    // apps/kortix-worker/src/worker.ts). OpenCode answers 204 and runs the turn
    // in the background; the worker matches that, so a send reaches the agent
    // and the reply streams back over /events.
    //
    // Without this route the request fell through to the cell's generic
    // handler, which answers 200 to ANY path. So the API believed every prompt
    // was delivered and no turn ever ran. Measured on dev 2026-09-07, session
    // ef37beb7: the session reached `ready` in 7.1 s, the prompt returned 200,
    // and no assistant message ever appeared — the worst shape of failure,
    // because nothing anywhere reported an error.
    //
    // Enqueued exactly like `/prompt?async=1`: persisted first, then the alarm
    // does the work, so nothing runs on this request's back and an eviction
    // mid-turn resumes rather than loses it.
    // POST /session/:rootId/abort — THE STOP BUTTON'S REAL PATH.
    //
    // The SDK builds its client with `baseUrl = <backend>/p/<externalId>/<port>`
    // and calls `session.abort()`, which resolves to `/session/:id/abort` at the
    // raw root with no prefix. kortix-worker learned this the hard way against
    // pi.kortix.com on 2026-09-01: the raw path 404'd, so Stop did nothing while
    // the UI painted "Interrupted" from its own optimistic receipt and the agent
    // ran to completion. A cell had the same hole.
    //
    // Idempotent and root-scoped, like the harness: aborting an idle session is
    // a no-op, and a request naming another session is refused rather than
    // stopping this one.
    {
      const m = url.pathname.match(/^\/session\/([^/]+)\/abort$/);
      if (m && req.method === "POST") {
        const rootId = decodeURIComponent(m[1]);
        if (rootId !== sessionId) {
          return Response.json({ error: "unknown session", expected: sessionId }, { status: 404 });
        }
        const running = this.running;
        if (running) running.agent.abort();
        return Response.json({ ok: true, stopped: !!running, turn: running?.turn ?? null });
      }
    }

    // GET /session/:rootId/message — the transcript, in the shape the raw
    // OpenCode client asks for. The harness serves it at the same raw root and
    // for the same reason: the SDK has no prefix.
    {
      const m = url.pathname.match(/^\/session\/([^/]+)\/message$/);
      if (m && req.method === "GET") {
        const rootId = decodeURIComponent(m[1]);
        if (rootId !== sessionId) {
          return Response.json({ error: "unknown session", expected: sessionId }, { status: 404 });
        }
        const rows = [...this.sql.exec("SELECT i, role, json, ts FROM msgs ORDER BY i")];
        return Response.json(rows.map((r) => {
          let parsed = {};
          try { parsed = JSON.parse(r.json); } catch { /* a row we cannot read is still a row */ }
          return {
            info: { id: String(r.i), role: r.role, sessionID: sessionId, time: { created: r.ts } },
            parts: (parsed.content ?? []).map((c, k) => ({
              id: `${r.i}-${k}`, messageID: String(r.i), sessionID: sessionId,
              type: c?.type === "text" ? "text" : (c?.type ?? "text"),
              ...(c?.text != null ? { text: c.text } : {}),
            })),
          };
        }));
      }
    }

    {
      const m = url.pathname.match(/^\/session\/([^/]+)\/prompt_async$/);
      if (m && req.method === "POST") {
        const rootId = decodeURIComponent(m[1]);
        // Root-scoped, like the worker: a prompt addressed to another session
        // must not run here just because it reached this cell.
        if (rootId !== sessionId) {
          return Response.json({ error: "unknown session", expected: sessionId }, { status: 404 });
        }
        const body = await req.json().catch(() => ({}));
        const parts = Array.isArray(body?.parts) ? body.parts : [];
        const text = parts
          .filter((x) => x && (x.type === "text" || typeof x.text === "string"))
          .map((x) => String(x.text ?? ""))
          .join("\n")
          .trim() || String(body?.text ?? "").trim();
        if (!text) return Response.json({ error: "no text in prompt" }, { status: 400 });
        this.sql.exec(
          "INSERT INTO turns(text, script, window, status, created_at, message_id, session_id) VALUES (?, NULL, 0, 'pending', ?, ?, ?)",
          text, Date.now(), typeof body?.messageID === "string" ? body.messageID : null, rootId,
        );
        await this.state.storage.setAlarm(Date.now() + 1);
        // 204, because that is what OpenCode answers and what the delivery loop
        // treats as accepted.
        return new Response(null, { status: 204 });
      }
    }

    if (path === "/prompt" && req.method === "POST") {
      const body = await req.json();
      const { script, contextWindow } = body;
      let { text } = body;
      // EXPLICIT INVOCATION: /prompt {skill, text}. pi formats the invocation
      // itself, so a named skill enters the conversation the way pi's own
      // harness enters it rather than as prose this cell invented.
      if (body.skill) {
        const { skills } = await this.skills(sessionId);
        const invocation = invokeSkill(skills, body.skill, text);
        // 404 rather than sending the model a prompt about a skill that is not
        // there: a typo'd skill name should fail loudly at the caller.
        if (!invocation) {
          return Response.json({ error: `no such skill: ${body.skill}`, available: skills.map((sk) => sk.name) }, { status: 404 });
        }
        text = invocation;
      }
      // ASYNC BY REQUEST, because holding a connection open for a whole agent
      // turn is the wrong shape and celld 0.4.0 makes that concrete.
      //
      // Measured across versions, six concurrent prompts to ONE cell:
      //   0.3.0  all six queue and answer 200
      //   0.4.0  one answers 200, five are closed mid-request
      //          ("incomplete_message ... connection closed before message
      //          completed"). Sequential to one cell is fine; concurrent to
      //          DIFFERENT cells is fine. It is concurrent requests to one
      //          Durable Object that 0.4.0 will not hold.
      //
      // An agent turn is 2-30 s of model time, so a held connection was already
      // fragile: a client that disconnects loses nothing that matters, since
      // the transcript is in SQLite either way. `?async=1` accepts the prompt,
      // queues it behind the same promise chain that orders turns, and answers
      // immediately. The caller watches /history or the WebSocket.
      const wantsAsync = url.searchParams.get("async") === "1";
      if (wantsAsync) {
        // Persist, then wake. Nothing runs on this request's back: the work
        // happens in the alarm, which the runtime is willing to run after the
        // response and after an eviction.
        this.sql.exec(
          "INSERT INTO turns(text, script, window, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
          text, script ? JSON.stringify(script) : null, Number(contextWindow ?? 0), Date.now(),
        );
        const row = this.sql.exec("SELECT MAX(i) AS i FROM turns").toArray()[0];
        await this.state.storage.setAlarm(Date.now() + 1);
        return Response.json({ ok: true, accepted: true, turn: row.i }, { status: 202 });
      }
      // Queued as ONE unit: the agent must be built (and therefore read the
      // transcript) after the previous turn has finished writing it, or it
      // starts from a context that is already out of date.
      const result = this.tail.then(async () => {
        const { block } = await this.skills(sessionId);
        const agent = this.buildAgent(sessionId, script, withSkills(SYSTEM_PROMPT, block));
        this.running = { agent, turn: null, sessionId };
        // The user message is persisted BEFORE the model runs. If the turn dies
        // mid-flight the prompt is still in the transcript, so a resume continues
        // rather than silently dropping what the user asked for.
        this.saveMessage("user", { role: "user", content: [{ type: "text", text }] });
        await agent.prompt(text);
        const compacted = await this.compactIfNeeded(sessionId, streamFnOf(agent), agent.state.model, contextWindow);
        if (compacted) this.broadcast({ type: "compacted", ...compacted });
        this.running = null;
        return this.sql.exec("SELECT COUNT(*) AS n FROM msgs").toArray()[0].n;
      });
      // The chain must survive a failed turn, or one error wedges the session
      // for good. Errors still reach the caller through `result`.
      this.tail = result.then(() => undefined, () => undefined);

      return Response.json({ ok: true, messages: await result });
    }

    if (path === "/history") {
      // The ACTIVE CONTEXT by default — what the model is actually working
      // from. `?all=1` adds everything compaction has summarised, which is the
      // record of what the agent did and is kept rather than deleted.
      const all = url.searchParams.get("all") === "1";
      const from = all ? 0 : this.contextFrom();
      const archived = this.sql.exec("SELECT COUNT(*) AS n FROM msgs WHERE i < ?", this.contextFrom()).toArray()[0].n;
      return Response.json({
        sessionId,
        archived,
        contextFrom: this.contextFrom(),
        messages: [...this.sql.exec("SELECT role, json, ts FROM msgs WHERE i >= ? ORDER BY i", from)]
          .map((r) => ({ role: r.role, ts: r.ts, message: JSON.parse(r.json) })),
      });
    }

    // Diagnostics: which model this cell would actually call, and everything it
    // could be pointed at without a code change.
    // ONE MODEL CALL, FROM INSIDE THE CELL, REPORTED HONESTLY.
    //
    // A turn that produces an empty assistant message and zero tokens says
    // nothing about why. The same request made from a laptop against the same
    // gateway with the same credential returns a completion, so the difference
    // is something only the cell can see — its own egress, its own parse, its
    // own timeout. This makes that difference readable instead of inferred.
    //
    // Never prints the credential: status, timings, byte counts and the first
    // few characters of content only.
    if (path === "/bench/model") {
      const e = normalizeModelEnv(this.effectiveEnv());
      if (!e.MODEL_BASE_URL || !e.MODEL_API_KEY) {
        return Response.json({ ok: false, reason: "no gateway or no key", hasGateway: !!e.MODEL_BASE_URL, hasKey: !!e.MODEL_API_KEY });
      }
      const t0 = Date.now();
      const out = { model: e.MODEL_ID, baseUrl: e.MODEL_BASE_URL };
      try {
        const res = await fetch(`${e.MODEL_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${e.MODEL_API_KEY}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: e.MODEL_ID,
            messages: [{ role: "user", content: url.searchParams.get("q") ?? "say pong" }],
            stream: url.searchParams.get("stream") !== "0",
          }),
        });
        out.status = res.status;
        out.headersMs = Date.now() - t0;
        const reader = res.body?.getReader();
        if (!reader) { out.body = (await res.text()).slice(0, 300); return Response.json(out); }
        const dec = new TextDecoder();
        let bytes = 0, keepAlives = 0, firstDataMs = 0, firstContentMs = 0, text = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          for (const line of dec.decode(value, { stream: true }).split("\n")) {
            if (line.startsWith(":")) { keepAlives++; continue; }
            if (!line.startsWith("data:")) continue;
            if (!firstDataMs) firstDataMs = Date.now() - t0;
            const b = line.slice(5).trim();
            if (b === "[DONE]") continue;
            try {
              const c = JSON.parse(b).choices?.[0]?.delta?.content;
              if (c && !firstContentMs) { firstContentMs = Date.now() - t0; text = String(c).slice(0, 24); }
            } catch { /* partial frame */ }
          }
        }
        Object.assign(out, { bytes, keepAlives, firstDataMs, firstContentMs, totalMs: Date.now() - t0, text });
      } catch (err) {
        out.error = String(err?.message ?? err).slice(0, 300);
        out.totalMs = Date.now() - t0;
      }
      return Response.json(out);
    }

    if (path === "/model") {
      const e = this.effectiveEnv();
      const c = modelConfig(e);
      // Length and segment count only — never the credential itself. Enough to
      // tell "the token did not arrive intact" from "the token is rejected",
      // which are the two failures that look identical from the outside.
      const key = e.MODEL_API_KEY ?? "";
      let claimOk = null;
      try {
        claimOk = !!JSON.parse(atob(key.split(".")[1]))?.["https://api.openai.com/auth"]?.chatgpt_account_id;
      } catch (e) { claimOk = `decode failed: ${e.message}`; }
      return Response.json({
        tools: (e.PT_API_URL && e.PT_SANDBOX_KEY && e.PT_WORKSPACE_ID)
          ? { backend: "platinum", api: e.PT_API_URL, workspace: e.PT_WORKSPACE_ID }
          : (this.cellFs || e.TOOLS_BACKEND === "cell" || normalizeModelEnv(e).MODEL_BASE_URL || e.KORTIX_SESSION_ID)
            // `files` is what is DURABLE — rows in the cell's SQLite — not the
            // in-memory tree, which carries just-bash's 181-path skeleton.
            // The table is made by cellFs() on the first tool build, so before
            // any turn there is nothing to count — and asking SQLite threw
            // "no such table" out of a read-only status route (kparity, 2026-09-07).
            ? { backend: "cell", cwd: "/work", files: this.cellFs ? (this.sql.exec("SELECT COUNT(*) AS n FROM files").toArray()[0]?.n ?? 0) : 0 }
            : { backend: "daemon", url: e.TOOL_DAEMON_URL },
        active: c ? { provider: c.model.provider, id: c.model.id, api: c.model.api, baseUrl: c.model.baseUrl } : "scripted",
        credential: { length: key.length, segments: key.split(".").length, accountIdClaim: claimOk },
        available: supportedProviders(),
      });
    }

    // What the transcript costs right now, and whether pi would compact it.
    if (path === "/context") {
      const c = modelConfig(this.effectiveEnv());
      const model = c?.model ?? pricedModel(this.env);
      const st = compactionState(this.loadMessages(), this.contextWindowFor(model, url.searchParams.get("window")));
      // THE TRANSCRIPT IS THE BILL, so show it in money as well as tokens.
      // pi's catalogue carries cost per million input tokens per model, so this
      // needs no table of our own and stays right when a price changes.
      //
      // `perTurn` is the number that actually matters: context is re-sent on
      // EVERY turn, so a session's cost grows with the square of its length.
      // That is what compaction is for.
      const rates = model?.cost;
      const perM = rates?.input;
      // ESTIMATED: what the next turn would cost at the full input rate, which
      // is the worst case and the planning number.
      const cost = typeof perM === "number" && perM > 0
        ? {
            currency: "USD",
            perMillionInputTokens: perM,
            perTurn: Number(((st.tokens / 1e6) * perM).toFixed(4)),
            per100Turns: Number(((st.tokens / 1e6) * perM * 100).toFixed(2)),
          }
        : undefined;

      // ACTUAL: what the provider says this session has already cost, priced at
      // the catalogue's own rates, with cache reads at their (much lower) rate.
      const u = this.sql.exec(
        `SELECT COUNT(*) AS turns, COALESCE(SUM(input),0) AS input, COALESCE(SUM(output),0) AS output,
                COALESCE(SUM(cache_read),0) AS cacheRead, COALESCE(SUM(cache_write),0) AS cacheWrite FROM usage`,
      ).toArray()[0];
      const spent = rates
        ? Number((((u.input * (rates.input ?? 0)) + (u.output * (rates.output ?? 0)) +
                   (u.cacheRead * (rates.cacheRead ?? 0)) + (u.cacheWrite * (rates.cacheWrite ?? 0))) / 1e6).toFixed(4))
        : undefined;
      // Without caching every cacheRead token would have been billed at the full
      // input rate. The difference is what pi's prompt caching is worth here.
      const savedByCache = rates && u.cacheRead
        ? Number(((u.cacheRead * ((rates.input ?? 0) - (rates.cacheRead ?? 0))) / 1e6).toFixed(4))
        : 0;
      const billed = u.input + u.cacheRead;
      const actual = {
        turnsWithUsage: u.turns,
        input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite,
        cacheHitRate: billed ? Number((u.cacheRead / billed).toFixed(3)) : 0,
        spentUSD: spent,
        savedByCacheUSD: savedByCache,
      };
      return Response.json({
        // The CONTEXT's message count, to match the token figure beside it.
        // These disagreed once the archive stopped being deleted: `tokens`
        // described the window and `messages` counted the whole table, so the
        // one number on this endpoint that says "how big is the context" was
        // the one that was wrong.
        messages: this.sql.exec("SELECT COUNT(*) AS n FROM msgs WHERE i >= ?", this.contextFrom()).toArray()[0].n,
        archived: this.sql.exec("SELECT COUNT(*) AS n FROM msgs WHERE i < ?", this.contextFrom()).toArray()[0].n,
        tokens: st.tokens,
        contextWindow: st.contextWindow,
        model: model ? `${model.provider}/${model.id}` : "scripted",
        wouldCompact: st.should,
        cost,
        actual,
        settings: st.settings,
      });
    }

    if (path === "/turns") {
      return Response.json({ turns: [...this.sql.exec("SELECT * FROM turns ORDER BY i")] });
    }

    if (path === "/ops") {
      return Response.json({ ops: [...this.sql.exec("SELECT * FROM ops ORDER BY started_at")] });
    }

    // How many sockets does THIS isolate believe it has? After an eviction the
    // object is re-created, so this answers whether a hibernated socket is
    // handed back to the new instance — the thing that decides if "parked
    // sessions cost a file descriptor" is true.
    // WHAT THIS CELL HAS DONE, for the control plane to meter.
    //
    // Cumulative and monotonic, never reset by reading: a meter that zeroed on
    // read would lose everything between the reader crashing and its next call,
    // and would make two readers each see half the truth. The CP takes
    // differences between readings instead.
    if (path === "/meter") {
      // Settle first: a reader must never see a number that is behind what the
      // cell has actually served, or the control plane would difference two
      // readings and bill the gap to whichever one happened to flush.
      this.flushMeter();
      const rows = [...this.sql.exec("SELECT k, n FROM meter ORDER BY k")];
      return Response.json({
        sessionId,
        meters: Object.fromEntries(rows.map((r) => [r.k, r.n])),
        // `instance` is memory, `meters.builds` is storage. Read together they
        // say whether a gap between two readings contained an eviction: a new
        // instance with a higher builds count is a rebuilt cell, the same
        // instance is a cell that stayed resident.
        instance: this.instance,
        instanceAgeMs: Date.now() - this.bornAt,
        ctorMs: this.ctorMs ?? null,
        initMs: this.initMs ?? null,
        at: Date.now(),
      });
    }

    // GET /events — SSE, the shape kortix-worker serves and the product reads.
    // THE STREAM, UNDER EVERY NAME A CLIENT ASKS FOR IT BY.
    //
    // The cell serves its event stream at `/events`. The product subscribes at
    // `/global/event` — OpenCode's name, which the daemon serves and the
    // frontend proxies to. On a cell that path fell through to the generic
    // handler at the bottom of this file, which answers 200 with JSON to ANY
    // path, so a subscriber received `{"ok":true,...}` once and then nothing:
    // no stream, no error, no way to tell the difference from a quiet session.
    //
    // Measured on dev 2026-09-09:
    //   /global/event   200 application/json   {"ok":true,"sessionId":...}
    //   /events?c=<id>  200 text/event-stream  ": connected"
    //
    // What it costs is the whole of streaming: a 200-word answer arrived as 703
    // bytes in a single step 6712 ms after the prompt, with nothing before it,
    // so the user watches a blank screen for the entire model call.
    //
    // Serving the same stream under the names clients use removes the silent
    // 200. It does NOT by itself make the UI render deltas — that also needs
    // these events in OpenCode's wire shape (kortix-worker's ChatEventAdapter
    // is the mapping) — and that is deliberately not claimed here.
    // THE ROUTE THE CONTROL PLANE OPENS.
    //
    // `openRuntimeEventStream` in the API fetches `<box>/kortix/opencode/events`
    // with `?since=` and `?epoch=` and requires `text/event-stream` back — it
    // treats a 200 that is not one as `daemon_protocol_unsupported` and takes
    // the backoff ladder, which is what the cell's catch-all used to produce.
    // Measured on dev 2026-09-09 before this existed: the UI stream announced
    // `{"state":"down","reason":"daemon_503"}` at 959 ms and carried no runtime
    // frame for the next 75 seconds.
    // THE DOCUMENT THE CONTROL PLANE READS ON EVERY SESSION OPEN — see
    // src/projection.js for the two rules that decide whether it is accepted
    // or stored and then refused.
    if (path === "/kortix/opencode/state") {
      const e = this.effectiveEnv();
      const c = modelConfig(e);
      const sid = this.wireSessionId(
        this.sql.exec("SELECT session_id FROM turns ORDER BY i DESC LIMIT 1").toArray()[0],
        sessionId,
      );
      let skills = [];
      try { ({ skills } = await this.skills(sid)); } catch { /* a cell with no workspace still has a projection */ }
      const doc = runtimeStateDoc({
        sessionId: sid,
        epoch: this.wire?.epoch ?? this.instance,
        seq: this.wire?.seq ?? 0,
        // `handle`, not `fetch`: this is the cell asking itself, so it must not
        // start a second `x-cell-ms` clock inside the one already running.
        sessions: await (await this.handle(new Request(`http://cell/session?c=${encodeURIComponent(sid)}`))).json(),
        busy: !!this.running,
        model: { id: c?.model ?? null, provider: c?.provider ?? null },
        skills,
        builtAt: Date.now(),
      });
      const etag = projectionEtag(doc);
      // The API sends If-None-Match on every refresh; answering 304 is what
      // keeps a session open from writing a new projection row each time.
      if (req.headers.get("if-none-match") === etag) {
        return new Response(null, { status: 304, headers: { etag } });
      }
      return Response.json(doc, { headers: { etag } });
    }

    if (path === "/kortix/opencode/events") {
      const bus = this.wire;
      const sinceRaw = url.searchParams.get("since");
      const since = sinceRaw === null || sinceRaw === "" ? null : Number(sinceRaw);
      const opening = bus.opening({ since, epoch: url.searchParams.get("epoch") });
      const enc = new TextEncoder();
      let writer = null;
      let beat = null;
      const set = bus.listeners;
      const stream = new ReadableStream({
        start(controller) {
          writer = { write: (line) => controller.enqueue(enc.encode(line)) };
          controller.enqueue(enc.encode(opening));
          set.add(writer);
          // A SILENT STREAM IS A CLOSED STREAM. Measured on dev 2026-09-09: an
          // attach with nothing to say was cut at 15161 ms and the API's pump
          // announced `{"state":"down","reason":"stream_ended"}`, then took the
          // backoff ladder — the flap this route exists to end. A comment costs
          // three bytes and is not an event, so it cannot advance a cursor or
          // reach a reducer.
          beat = setInterval(() => {
            try { controller.enqueue(enc.encode(": beat\n\n")); }
            catch { clearInterval(beat); }
          }, WIRE_HEARTBEAT_MS);
        },
        cancel() { set.delete(writer); if (beat) clearInterval(beat); },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          // The API reads the boot id off the HEADER as well as the hello, so a
          // caller that never parses a frame still knows which epoch it got.
          "x-kortix-epoch": bus.epoch,
          "x-accel-buffering": "no",
        },
      });
    }

    if (path === "/events" || path === "/global/event" || path === "/event") {
      this.sseListeners = this.sseListeners ?? new Set();
      const set = this.sseListeners;
      const enc = new TextEncoder();
      let writer = null;
      const stream = new ReadableStream({
        start(controller) {
          writer = { write: (line) => controller.enqueue(enc.encode(line)) };
          set.add(writer);
          // An immediate comment so a proxy flushes headers and a client knows
          // it is connected before anything happens.
          controller.enqueue(enc.encode(": connected\n\n"));
        },
        cancel() { set.delete(writer); },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          // The edge must not sit on this waiting for a full body.
          "x-accel-buffering": "no",
        },
      });
    }

    if (path === "/sockets") {
      // BOTH SOURCES, because they disagree after an eviction and the
      // disagreement is the interesting part: the runtime may hand back none
      // while the cell has re-adopted one from an inbound message.
      const held = this.state.getWebSockets?.() ?? [];
      const union = new Set(held);
      for (const w of this.sockets) union.add(w);
      return Response.json({
        sockets: union.size,
        fromRuntime: held.length,
        readopted: this.sockets.size,
        tags: held.map((w) => this.state.getTags?.(w) ?? null),
      });
    }

    // FORK A SESSION. Branch a conversation at a point and carry on separately.
    //
    // pi has a session TREE for this — entries with parent ids, lanes, branch
    // bounds — behind an 18-method SessionStorage interface. Implementing that
    // over SQLite to get one user-visible feature is the wrong trade here,
    // because a cell already IS a session: its transcript is its storage, and a
    // fork is another cell holding a prefix of it.
    //
    // A cell cannot write another cell's SQLite — that is the isolation the
    // whole design rests on — so the parent READS its own messages and the child
    // IMPORTS them over the Durable Object binding. One RPC, no shared state.
    if (path === "/fork" && req.method === "POST") {
      const { to, upTo } = await req.json();
      if (!to || typeof to !== "string") return Response.json({ error: "to (a session id) is required" }, { status: 400 });
      if (to === sessionId) return Response.json({ error: "a session cannot fork onto itself" }, { status: 400 });

      // The ACTIVE CONTEXT, not the archive. A fork is a branch of the
      // conversation the model is in; handing the child a summarised archive it
      // has no watermark for would put messages in its context that this cell
      // had already decided were too old to send.
      const all = [...this.sql.exec("SELECT role, json FROM msgs WHERE i >= ? ORDER BY i", this.contextFrom())];
      // `upTo` counts MESSAGES, not turns, and is clamped rather than rejected:
      // a caller asking for more than exists means "all of it".
      const take = typeof upTo === "number" && upTo >= 0 ? Math.min(upTo, all.length) : all.length;
      const slice = all.slice(0, take);

      const child = this.env.AGENT.get(this.env.AGENT.idFromName(to));
      const res = await child.fetch(new Request("http://cell/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: sessionId, messages: slice.map((r) => ({ role: r.role, message: JSON.parse(r.json) })) }),
      }));
      const body = await res.json();
      if (!res.ok) return Response.json({ error: "the fork target refused the import", detail: body }, { status: res.status });
      return Response.json({ ok: true, to, forked: slice.length, of: all.length });
    }

    // The other half of /fork. Refuses a session that already has a transcript:
    // silently merging two conversations is worse than failing, and a fork onto
    // a live session is a mistake rather than an intention.
    if (path === "/import" && req.method === "POST") {
      const { from, messages } = await req.json();
      const existing = this.sql.exec("SELECT COUNT(*) AS n FROM msgs").toArray()[0].n;
      if (existing > 0) {
        return Response.json({ error: "this session already has a transcript", messages: existing }, { status: 409 });
      }
      for (const m of messages ?? []) this.saveMessage(m.role, m.message);
      // The ops ledger is NOT copied. Those ids belong to calls the parent made;
      // duplicating them would let the child claim a tool call it never issued,
      // and the daemon would answer its retry from the parent's result.
      this.sql.exec(
        "INSERT INTO ops(id, kind, detail, status, started_at, ended_at) VALUES (?, 'fork', ?, 'done', ?, ?)",
        `fork_${Date.now().toString(36)}`, `forked from ${from}`, Date.now(), Date.now(),
      );
      return Response.json({ ok: true, imported: (messages ?? []).length, from });
    }

    if (path === "/reset") {
      this.sql.exec("DELETE FROM msgs");
      this.sql.exec("DELETE FROM ops");
      // The context watermark has to go with them. Left behind, it points past
      // every row in an empty table and the session loads nothing forever.
      this.sql.exec("DELETE FROM meta WHERE k='context_from'");
      // THE METER IS NOT CLEARED. /reset is a conversation operation, and the
      // party being billed must not be able to erase the bill by calling it.
      // Work already done stays counted.
      return Response.json({ ok: true });
    }

    // The cell's own root is a real answer: "I am here, I am this session, and
    // this is how much of it there is." The probes read it and it costs two
    // counts. Everything BELOW it is a path nobody wrote.
    if (path === "/") {
      return Response.json({
        ok: true,
        sessionId,
        messages: this.sql.exec("SELECT COUNT(*) AS n FROM msgs").toArray()[0].n,
        ops: this.sql.exec("SELECT COUNT(*) AS n FROM ops").toArray()[0].n,
      });
    }

    // A ROUTE THAT DOES NOT EXIST IS NOT A SUCCESS.
    //
    // This used to answer 200 `{ok:true,…}` to every unmatched path, and that
    // one shrug has now cost four separate investigations: `/global/event`
    // looked implemented, `/session/<id>/model` looked implemented, and the
    // control plane's `GET /kortix/opencode/state` — which the cell does not
    // serve at all — looks implemented to this day. A caller checking
    // `res.ok` cannot tell a served route from an invented one.
    //
    // The counts stay in the body, because they are what the probes read and
    // they cost one query; the STATUS is what changes, and it is the part a
    // caller believes.
    return Response.json({
      ok: false,
      error: "unknown route",
      path,
      sessionId,
      messages: this.sql.exec("SELECT COUNT(*) AS n FROM msgs").toArray()[0].n,
      ops: this.sql.exec("SELECT COUNT(*) AS n FROM ops").toArray()[0].n,
    }, { status: 404 });
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ ok: true, agent: "pi-in-a-cell" });

    // SPAWN, MEASURED THE WAY A LIBRARY MEASURES IT.
    //
    // agentOS reports 4.8 ms p50 for "time from requesting an execution to
    // first code running", in-process on one machine — no socket, no TLS, no
    // proxy. Every number taken from outside this node includes all three, so
    // comparing them is comparing a function call with a request to Paris.
    //
    // This is the same quantity for a cell: ask the binding for an isolate that
    // has never existed and stop the clock when its code answers. /ping is used
    // deliberately because it returns BEFORE init(), so the reading is the
    // spawn and not the schema.
    //
    // Measured on dev 2026-09-07 for the record kept in the comparison: from
    // outside, subtracting two readings over the identical path, the spawn was
    // 67 ms. This says what it is with nothing subtracted.
    // WHAT A CELL CANNOT RUN, established 2026-09-07 and recorded rather than
    // re-probed.
    //
    // A /bench/can endpoint asked this isolate three questions and each one
    // dropped the connection — HTTP 000, with the cell still answering /health
    // afterwards. Not a catchable error: a refusal below the language.
    //
    //   `await import("node:child_process")`   dropped
    //   `eval("1+1")`                          dropped
    //   `new WebAssembly.Module(<bytes>)`      dropped
    //
    // The last one is the interesting one. A Workers-style runtime takes
    // WebAssembly as a BUNDLED module, never as bytes compiled at runtime, and
    // compiled-tools-loaded-at-runtime is exactly how agentOS ships its tools.
    // Together with a kernel that lives in a sidecar PROCESS owning a virtual
    // filesystem, process table, PTYs and a network stack, that settles it:
    // agentOS cannot run INSIDE a cell. Not because a cell is single-threaded —
    // it is, and that was never the obstacle — but because a cell has no
    // processes, no native addons, and no runtime codegen.
    //
    // The endpoint is gone because an endpoint that kills its own request has
    // no business shipping. The answer is here.
    if (url.pathname === "/bench/spawn") {
      const n = Math.max(1, Math.min(Number(url.searchParams.get("n") ?? 25), 200));
      // WHERE THE COLD MILLISECONDS ACTUALLY GO, in two readings over the same
      // path rather than one number and a story about it.
      //
      // `/ping` answers BEFORE init(), so the default reading is isolate +
      // script evaluation + constructor and NOTHING durable. `?to=turns` stops
      // instead at a route that runs init() and reads a table, which is the
      // first thing that can force the object-storage lease and the schema.
      // Subtracting them is the cost of a cell HAVING state, which is exactly
      // the thing agentOS's 4.8 ms does not pay for: it has no durable store
      // per instance, so there is nothing to lease.
      //
      // MEASURED 2026-09-09 on a probe box with nothing else on it, 80 cold
      // spawns each, alternating so drift hit both readings equally:
      //
      //                    median of p50s     floor (fastest of 80)
      //   stop=/ping           122.5 ms            39.5 ms
      //   stop=/turns           82.0 ms            51.5 ms
      //
      // Read the FLOORS. The p50s are inverted — doing strictly more work
      // cannot be faster — which is itself the result: in the middle of the
      // distribution, node scheduling dominates and the work does not show.
      //
      // THIS CORRECTS THE RECORD. It was written here that the 65-96 ms first
      // touch is celld's object-storage lease and therefore architectural. The
      // durable half is ~12 ms of it. The other ~40 ms is celld routing to and
      // starting an isolate, BEFORE any storage — and it does not move with
      // the bundle either: a 38% smaller bundle floored at the same 20-35 ms
      // (see build.mjs). So the cold cost is neither the lease nor the code
      // size; it is the isolate boundary itself, which is the one thing
      // agentOS's in-process number never crosses.
      const stop = url.searchParams.get("to") === "turns" ? "/turns" : "/ping";
      const t = [];
      for (let i = 0; i < n; i++) {
        const name = `bench-${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 8)}`;
        const t0 = performance.now();
        await env.AGENT.get(env.AGENT.idFromName(name)).fetch(new Request(`http://cell${stop}`));
        t.push(performance.now() - t0);
      }
      t.sort((a, b) => a - b);
      const at = (q) => Math.round(t[Math.min(t.length - 1, Math.floor(t.length * q))] * 100) / 100;
      return Response.json({
        n, stop,
        p50: at(0.5), p90: at(0.9), p99: at(0.99),
        min: Math.round(t[0] * 100) / 100,
        max: Math.round(t[t.length - 1] * 100) / 100,
        note: "in-node: no network, no TLS, no edge — the same quantity agentOS reports as 4.8 ms",
      });
    }
    // The session polls readiness BEFORE it has a session to name, so this one
    // answers at the worker, not in a cell.
    if (url.pathname === "/kortix/health" && !url.searchParams.get("c")) {
      // Same contract as the in-cell answer: the session polls readiness
      // BEFORE it has a session to name, and a body this one cannot classify
      // leaves it waiting exactly as long as an unreachable box would.
      return Response.json({
        daemon: "ok", status: "ok", runtimeReady: true, workload: "session",
        opencode: "ok", engine: "pi", repo_required: false, repo_ready: true,
        boot_error: null, store_error: null, model_error: null,
        opencode_session_required: false, opencode_session_id: null,
        agent_config_etag: null, commit_sha: null, branch: null,
        runtime: { build: null, at: null, components: {}, agentSwapPending: false, pinned: false },
        ok: true, agent: "pi-in-a-cell",
      });
    }
    // WHICH CELL, when the caller cannot say.
    //
    // A Kortix session reaches this worker through the API's sandbox proxy,
    // which forwards the path and NOT the query — so `?c=` is absent on every
    // request the product makes. Defaulting to "default" put all of them on an
    // isolate that is nobody's session: the pin resolved to that isolate's
    // internal id, and the delivery POST to /session/<the real session>/
    // prompt_async then 404'd against it. Measured on dev 2026-09-07, session
    // 16310084: GET /session through the proxy answered 200 while
    // prompt_async 404'd on both 8000 and 8080.
    //
    // A Platinum cell sandbox holds exactly ONE Kortix session, and its id is
    // in the environment the create put there. So that is the identity to fall
    // back on: `?c=` still works for callers that name a cell (the suites, the
    // eviction probes), and everything else lands on the session this cell was
    // made for.
    // The path names the session too, and that is what makes ONE cell sandbox
    // able to hold MANY sessions. Every route the control plane calls carries
    // the session in the path — /session/:id/prompt_async, /session/:id/abort —
    // so a request that names one there does not need `?c=`, which the proxy
    // drops anyway.
    //
    // Why it matters: a session currently costs a whole Platinum sandbox, and
    // that is where the seconds are. Measured on dev 2026-09-07, warm node:
    // POST 198 ms, row running at 1296 ms, expose 141 ms, edge live 928 ms
    // later — 2443 ms before anything can answer. Spawning another isolate on
    // a cell that already exists is 86 ms resumed, 146 ms new.
    const fromPath = url.pathname.match(/^\/session\/([^/]+)(?:\/|$)/);
    const name = url.searchParams.get("c")
      ?? (fromPath ? decodeURIComponent(fromPath[1]) : null)
      ?? env.KORTIX_SESSION_ID
      ?? null;

    // "default" IS THE ONE NAME celld CANNOT ROUTE, and it was this worker's
    // fallback.
    //
    // Measured on dev 2026-09-09 against a box thirty seconds old, so this is
    // not stale ownership — it is the literal string:
    //
    //   ?c=default   Worker failed: rejected: DurableObjectRoutingError:
    //                The Durable Object owner is currently unreachable
    //   ?c=Default   200      ?c=DEFAULT  200      ?c=default1  200
    //   ?c=main 200   ?c=agent 200   ?c=session 200   ?c=<uuid> 200
    //
    // Every other name in that list routes. So any cell that reached the
    // fallback answered 500 to every request, and a cell reaches the fallback
    // exactly when its box came back without `KORTIX_SESSION_ID` — which is
    // what a RESUMED sandbox did until `sandbox.start` began carrying env.
    // Three of the four cell boxes running on dev at the time were in that
    // state: every request the product made to them, none of which can carry
    // `?c=` through a proxy that drops the query, failed at the router.
    //
    // AND ROUTING IT WOULD BE WORSE THAN FAILING, because a cell name is not
    // scoped to its sandbox. Measured the same day: a box created seconds
    // earlier, asked for the cell `sess-b`, answered with forty messages
    // written 100 minutes before by a box that no longer exists. To repeat
    // it: create a cell sandbox and GET /history?c=<a name an older box used>.
    // Cell state is keyed by NAME across every
    // sandbox sharing the deployment's storage identity. A session id is a
    // uuid and cannot collide; "default" collides with every other box that
    // ever lost its env, so the fallback was one shared transcript for all of
    // them. celld refusing to route it is the only reason that never happened.
    //
    // Refusing is the honest answer. A request that names no session on a box
    // that knows no session has no isolate to go to, and inventing one is how
    // a user ends up talking to an empty agent that answers with the scripted
    // fixture. 503, because re-pushing the session env repairs it.
    if (name === null || name === "default") {
      return Response.json({
        error: "no session named",
        detail: name === "default"
          ? "celld cannot route a cell named \"default\""
          : "this box has no KORTIX_SESSION_ID; name the session with ?c= or /session/<id>/",
        hint: "POST /kortix/env?c=<session> to configure this box",
      }, { status: 503, headers: { "retry-after": "5" } });
    }
    return env.AGENT.get(env.AGENT.idFromName(name)).fetch(req);
  },
};
