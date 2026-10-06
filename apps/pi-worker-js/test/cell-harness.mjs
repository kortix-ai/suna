// A FAKE DURABLE OBJECT, BACKED BY REAL SQLITE.
//
// Most of what can go wrong in worker.js is logic, not celld: route dispatch,
// the kortixd contract's shapes, prompt admission, the turn-end relay, env
// pushes. None of it needs Docker, MinIO or a cell node to exercise.
//
// `state.storage.sql` is SQLite, `state.storage.transaction` is a SQLite
// transaction (pi-durable's storage adapter needs both), `setAlarm` is a timer,
// and the class under test is the one that ships: suites import
// dist/worker.js, the actual bundle, so nothing is re-implemented or mocked
// away. If the bundle is broken, this breaks. A scripted turn (pi-ai's faux
// provider, `CELL_MODEL=faux`) runs the real pi-durable harness end to end in
// about 100 ms.
//
// What it deliberately does NOT test: replication, eviction, hibernation,
// deployment adoption. Those are celld's, and pretending otherwise is how a
// fake becomes a lie.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mintWireMessageId } from "../../../packages/sdk/src/core/session/wire-message-id.ts";

/**
 * The root a cell serves for a Kortix session: `ses_pi` + 24 hex of
 * sha256("pi-root\0" + session). Computed HERE with node:crypto rather than
 * imported from src/kortix/ids.js, so a suite that addresses a root by it
 * also checks the worker's own derivation (kortixd's formula).
 */
export const rootIdOf = (session) => `ses_pi${createHash("sha256").update(`pi-root\0${session}`).digest("hex").slice(0, 24)}`;

/** A Kortix wire message id, minted by the SDK's own codec — what a client sends. */
export const newMessageId = () => mintWireMessageId({ nowMs: Date.now(), backdateMs: 0 });

/** celld hands the worker a `sql` with .exec(query, ...args) -> iterable + toArray(). */
// A CURSOR IS CONSUMED ONCE, as Cloudflare's SqlStorageCursor is.
//
// This double used to hand back the same rows however many times they were
// asked for, which is MORE PERMISSIVE THAN PRODUCTION: worker code that read a
// cursor twice would pass every test here and get nothing the second time in a
// real cell. That is precisely the shape of bug this harness exists to catch,
// and it could not have seen it.
//
// A second read THROWS rather than returning empty, because empty is what the
// bug looks like in production and a double should name it rather than
// reproduce it.
function cursor(rows, query) {
  let spent = false;
  const consume = (how) => {
    if (spent) {
      throw new Error(
        `SQL cursor consumed twice (${how}) — a real cell returns nothing the second time. ` +
        `Read it once: ${String(query).slice(0, 80)}`,
      );
    }
    spent = true;
    return rows;
  };
  // `.next()` reads row by row, as a real cursor does; the first call spends
  // the cursor like the other two ways of reading it.
  let iter = null;
  return {
    toArray: () => consume("toArray"),
    next: () => (iter ??= consume("next")[Symbol.iterator]()).next(),
    [Symbol.iterator]: function* () { yield* consume("iteration"); },
  };
}

/** Blobs bind as Uint8Array in node:sqlite; a cell binds ArrayBuffers. */
const bindArg = (v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v);
/** A cell reads blobs back as ArrayBuffers; node:sqlite hands Uint8Arrays. */
const readRow = (r) => {
  const out = { ...r };
  for (const k of Object.keys(out)) {
    if (out[k] instanceof Uint8Array) out[k] = out[k].buffer.slice(out[k].byteOffset, out[k].byteOffset + out[k].byteLength);
  }
  return out;
};

function makeSql(db, log) {
  return {
    exec(query, ...args) {
      const trimmed = query.trim();
      // EVERY STATEMENT, recorded. A cell's SQLite is flushed to object storage
      // on every change, so "did this do any work at all" is a question with a
      // bill attached — and it is the only way to claim an early return that
      // SQLite's own NULL handling would otherwise make invisible.
      log?.push(trimmed);
      // Several statements in one string (a schema), which prepare refuses.
      if (args.length === 0 && /;\s*\S/.test(trimmed.replace(/'(?:[^']|'')*'/g, "''"))) {
        db.exec(trimmed);
        return cursor([], trimmed);
      }
      // ONE PATH FOR EVERY STATEMENT: `.all()` runs a write and returns no rows,
      // so a CTE, an upsert or a STRICT CREATE is not misread by a keyword test.
      const rows = db.prepare(trimmed).all(...args.map(bindArg)).map(readRow);
      return cursor(rows, trimmed);
    },
    get databaseSize() {
      return db.prepare("SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()").get().n;
    },
  };
}

/**
 * `storage.transaction(fn)`, as a Durable Object has it: the callback's
 * statements commit together, and a rejected callback rolls them back and
 * rejects with the same error. pi-durable's storage adapter depends on both.
 */
export function makeTransaction(db) {
  let depth = 0;
  return async function transaction(fn) {
    const savepoint = `sp${depth++}`;
    db.exec(depth === 1 ? "BEGIN" : `SAVEPOINT ${savepoint}`);
    try {
      const value = await fn();
      db.exec(depth === 1 ? "COMMIT" : `RELEASE ${savepoint}`);
      return value;
    } catch (error) {
      db.exec(depth === 1 ? "ROLLBACK" : `ROLLBACK TO ${savepoint}`);
      throw error;
    } finally {
      depth--;
    }
  };
}

/** A Durable Object's `storage`, over one SQLite database: what pi's adapter takes. */
export function makeStorage(db = new DatabaseSync(":memory:"), log) {
  return { sql: makeSql(db, log), transaction: makeTransaction(db), db };
}

/**
 * A Durable Object namespace over a set of harness cells — `env.AGENT` for the
 * worker's default-export router, which names an object per session root. Each
 * name gets its own cell with its own SQLite, because that isolation is the
 * thing being relied on.
 */
export function makeNamespace(AgentCell, env = {}) {
  const cells = new Map();
  const ns = {
    idFromName: (name) => ({ toString: () => name, name }),
    get: (id) => {
      const name = id.name ?? id.toString();
      if (!cells.has(name)) cells.set(name, makeCell(AgentCell, { ...env, AGENT: ns }, { id: name }));
      return { fetch: (req) => cells.get(name).cell.fetch(req) };
    },
  };
  return {
    ns,
    cell: (name) => { ns.get(ns.idFromName(name)); return cells.get(name); },
  };
}

export function makeCell(AgentCell, env = {}, opts = {}) {
  // `opts.db` REBUILDS A CELL ON EXISTING STORAGE, which is what an eviction is:
  // celld destroys the isolate and constructs a new instance against the same
  // SQLite. Without this the harness could only ever test a fresh cell, so
  // anything held in instance state passed — including a meter that reset on
  // every eviction, which is the normal way an idle cell exists.
  const db = opts.db ?? new DatabaseSync(":memory:");
  let alarmAt = null;
  const alarmTimers = [];
  const sockets = [];
  const acceptedTags = [];
  const autoResponses = [];
  const sqlLog = [];

  const state = {
    id: { toString: () => opts.id ?? "harness-cell" },
    storage: {
      sql: makeSql(db, sqlLog),
      transaction: makeTransaction(db),
      // ALARMS MAY OVERLAP, because on celld 0.3.0 they do.
      //
      // The first version of this harness cleared the pending timer on every
      // setAlarm, so exactly one alarm was ever in flight — and a harness that
      // cannot overlap cannot reproduce the bug that mattered: six concurrent
      // alarms each claiming a DIFFERENT pending turn. Removing the global
      // `NOT EXISTS (... running)` guard from the worker passed cleanly against
      // it, which is a harness quietly certifying a broken claim.
      //
      // celld 0.4.0 serialises them; 0.3.0 does not. Modelling the version that
      // does NOT is the useful choice: a queue correct under overlap is correct
      // under serialisation, and never the other way round.
      // BOTH RUNTIMES, because the worker must be correct on both.
      //
      // The note above explains why overlap is modelled: a queue correct under
      // overlap is correct under serialisation. That is true of the CLAIM race,
      // and it hid the opposite hazard — under Cloudflare's and celld 0.4.0's
      // AT-MOST-ONE-ALARM rule, calling setAlarm twice before it fires leaves
      // ONE alarm. One alarm runs one turn, and a queue that does not re-arm
      // strands every turn after the first, forever.
      //
      // Modelling only overlap gives every prompt its own timer, so the re-arm
      // is never needed and its absence is invisible. `alarms: "coalesce"` is
      // the other runtime, and the queue has to drain under both.
      async setAlarm(at) {
        alarmAt = at;
        if (opts.alarms === "coalesce") { for (const t of alarmTimers.splice(0)) clearTimeout(t); }
        // alarmDelayMs holds delivery back so a test can get several turns PENDING
        // before a single alarm fires. Without it the worker's now+1ms alarm
        // fires between prompts, every turn gets its own, and coalescing changes
        // nothing — which is exactly what the first version of this measured.
        const delay = Math.max(1, (at - Date.now()) + (opts.alarmDelayMs ?? 0));
        const t = setTimeout(() => { alarmAt = null; cell.alarm().catch(() => {}); }, delay);
        alarmTimers.push(t);
      },
      async getAlarm() { return alarmAt; },
    },
    // HIBERNATION IS OPTIONAL, so both runtimes have to be modelled.
    //
    // The worker asks `typeof this.state.acceptWebSocket === "function"` and
    // falls back to a plain accept() when it is not there. A harness that always
    // provides it never runs the fallback, and never runs the CHOICE either —
    // so a version that called acceptWebSocket unconditionally would pass here
    // and throw a TypeError on any runtime without it. `sockets: "plain"` is the
    // other runtime.
    ...(opts.sockets === "plain" ? {} : {
      acceptWebSocket(ws, tags) { sockets.push(ws); acceptedTags.push(tags); },
      setWebSocketAutoResponse(pair) { autoResponses.push(pair); },
    }),
    getWebSockets() { return sockets; },
    getTags() { return []; },
  };

  const cell = new AgentCell(state, env);
  return {
    cell,
    db,
    /** What the runtime was handed: tags per accepted socket, and any ping/pong pair. */
    acceptedTags,
    autoResponses,
    /** Every SQL statement this cell has run, in order. */
    sqlLog,
    /** The same storage, a new instance — an eviction, as celld performs one. */
    rebuild: () => makeCell(AgentCell, env, { ...opts, db }),
    sockets,
    /** Drive a request the way celld would. */
    fetch: (path, init) => cell.fetch(new Request(`http://cell${path}`, init)),
    /**
     * Wait until every admitted turn has ended, so a test asserts on a settled
     * cell. The cell's own ledger (engine.js `kx_turns`): one row per admitted
     * user message, `queued` -> `running` -> `done` | `error`.
     */
    async drain(ms = 8000) {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        let left = 0;
        try { left = db.prepare("SELECT COUNT(*) AS n FROM kx_turns WHERE status IN ('queued','running')").get()?.n ?? 0; } catch { /* no turn admitted yet */ }
        if (left === 0) return true;
        await new Promise((r) => setTimeout(r, 25));
      }
      return false;
    },
    /** Poll `/kortix/health` until the cell reports `runtimeReady`; the last answer. */
    async ready(ms = 5000) {
      const until = Date.now() + ms;
      let last = null;
      while (Date.now() < until) {
        last = await (await cell.fetch(new Request("http://cell/kortix/health"))).json();
        if (last.runtimeReady) return last;
        await new Promise((r) => setTimeout(r, 20));
      }
      return last;
    },
    rows: (sql) => db.prepare(sql).all().map((r) => ({ ...r })),
  };
}

/** The bundle needs a couple of globals celld provides and node does not. */
export function installWorkerGlobals() {
  if (typeof globalThis.WebSocketPair === "undefined") {
    globalThis.WebSocketPair = function () {
      const mk = () => ({ sent: [], send(m) { this.sent.push(m); }, close() {}, accept() {} });
      const a = mk(), b = mk();
      return { 0: a, 1: b };
    };
  }
  if (typeof globalThis.WebSocketRequestResponsePair === "undefined") {
    globalThis.WebSocketRequestResponsePair = function (req, res) { return { req, res }; };
  }
  // A 101 WITH A SOCKET ON IT, which is how a Worker completes an upgrade and
  // which node's Response refuses outright ("status must be in the range of 200
  // to 599"). Without this the upgrade path cannot be exercised at all outside
  // a container — which is why it never was.
  //
  // Only 101 is treated specially; every other status goes to the native
  // constructor untouched, so this cannot quietly change what the rest of the
  // suites see.
  if (!globalThis.__cellResponsePatched) {
    const Native = globalThis.Response;
    globalThis.Response = class extends Native {
      constructor(body, init) {
        const upgrade = init?.status === 101;
        const { status, webSocket, ...rest } = init ?? {};
        super(upgrade ? null : body, upgrade ? { ...rest, status: 200 } : init);
        if (upgrade) Object.defineProperty(this, "status", { value: 101, configurable: true });
        if (webSocket !== undefined) Object.defineProperty(this, "webSocket", { value: webSocket, configurable: true });
      }
    };
    globalThis.__cellResponsePatched = true;
  }
}
