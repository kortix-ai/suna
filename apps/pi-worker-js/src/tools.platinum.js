// THE PLATINUM-NATIVE TOOL BACKEND — the platform's own API, not a parallel one.
//
// The daemon in daemon/server.js was a mistake worth admitting: Platinum already
// exposes everything an agent's tools need on a sandbox, and building a second
// exec service next to it means reimplementing — badly, or not at all — audit,
// billing, quotas, the spend gate, org isolation, activity bumps for the reaper,
// and the env-var injection /exec does at create time.
//
// It also means a second credential. sandboxScope.ts opens with the sentence
// that settles the whole design:
//
//   "Sandbox-scoped API keys — a key confined to ONE sandbox and its children,
//    so you can hand an agent running inside a sandbox a credential that cannot
//    touch the rest of the org."
//
// That is this use case, already built, already tested, already enforced in four
// places (scope guard, object confinement, ownership, and the capability gate).
// A `sandbox:<workspace-id>` key is exactly what a cell should carry.
//
// So these tools speak the real routes:
//
//   bash   POST /v1/sandboxes/:id/exec         {cmd, timeout_ms}
//   read   GET  /v1/sandboxes/:id/files        ?path=&offset=&limit=
//   write  PUT  /v1/sandboxes/:id/files        ?path=
//   list   GET  /v1/sandboxes/:id/files/list   ?path=
//   grep   GET  /v1/sandboxes/:id/files/grep   ?path=&pattern=&max=
//
// grep and list are the two the daemon never had and a coding agent always
// wants. They come free with the platform.
//
// The op ledger stays. Platinum's /exec has no idempotency key — and its own
// comment explains why that matters: a TIMEOUT means the command WAS delivered
// and may still be running, so re-dispatching "executes the payload a SECOND
// time. Measured in prod 2026-07-31." The cell records intent before the call
// for exactly that reason.
import { Type } from "typebox";

function ledger(sql) {
  return {
    /** Was this exact call already attempted and left unfinished? */
    priorAttempt(id) {
      const row = sql.exec("SELECT status FROM ops WHERE id = ?", id).toArray()[0];
      return row?.status === "running";
    },
    begin(id, kind, detail) {
      sql.exec(
        "INSERT OR IGNORE INTO ops(id, kind, detail, status, started_at) VALUES (?, ?, ?, 'running', ?)",
        id, kind, detail, Date.now(),
      );
    },
    finish(id, status, out) {
      sql.exec("UPDATE ops SET status = ?, out = ?, ended_at = ? WHERE id = ?", status, out, Date.now(), id);
    },
  };
}

class PlatinumApi {
  constructor(env) {
    this.base = String(env.PT_API_URL ?? "").replace(/\/+$/, "");
    this.token = env.PT_SANDBOX_KEY;
    this.sandbox = env.PT_WORKSPACE_ID;
    if (!this.base || !this.token || !this.sandbox) {
      throw new Error(
        "the platinum tool backend needs PT_API_URL, PT_SANDBOX_KEY and PT_WORKSPACE_ID " +
        "(the key should be scoped `sandbox:<PT_WORKSPACE_ID>`)",
      );
    }
  }

  async call(method, path, { query, body, raw } = {}) {
    const url = new URL(`${this.base}/v1/sandboxes/${this.sandbox}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (raw) return { status: res.status, text };
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text.slice(0, 400) }; }
    // Surface the platform's own refusal rather than a generic failure: a 403
    // from the scope guard and a 501 from the capability gate mean very
    // different things to whoever is reading the transcript.
    if (!res.ok) {
      const code = json?.code ? ` [${json.code}]` : "";
      throw new Error(`${method} ${path} -> ${res.status}${code}: ${json?.error ?? text.slice(0, 200)}`);
    }
    return json;
  }
}

export function platinumTools(env, _sessionId, sql) {
  const api = new PlatinumApi(env);
  const log = ledger(sql);

  const tool = (name, label, description, parameters, run) => ({
    name, label, description, parameters,
    execute: async (toolCallId, params) => {
      // NOTHING ON THIS PATH CAN DEDUPLICATE, so the cell must not pretend.
      //
      // The daemon backend has an in-flight join and a result cache. Platinum's
      // /exec has neither — it takes no idempotency key. The route's own comment
      // records what that costs when something retries anyway: a TIMEOUT means
      // "the command WAS delivered and may still be running, so re-dispatching
      // executes the payload a SECOND time. Measured in prod 2026-07-31." The
      // platform answers a timeout with 504 exec_timeout rather than retrying,
      // for exactly that reason.
      //
      // A cell that died mid-call and resumed is the same situation from the
      // other side: the op is still 'running' in its own ledger, the outcome is
      // unknown, and the honest move is to say so rather than run it again.
      // Silently repeating is how `rm -rf build && ...` happens twice.
      if (log.priorAttempt(toolCallId)) {
        const text =
          `This exact tool call was already attempted and was interrupted before its result was recorded. ` +
          `It may have completed. This backend has no idempotency key, so repeating it could run it a second time. ` +
          `Check the workspace state first, then issue a NEW call if the work still needs doing.`;
        log.finish(toolCallId, "unknown", text);
        return { content: [{ type: "text", text }], details: { via: "platinum", unknownOutcome: true } };
      }
      log.begin(toolCallId, name, JSON.stringify(params).slice(0, 400));
      try {
        const text = await run(params, toolCallId);
        log.finish(toolCallId, "done", text);
        return { content: [{ type: "text", text }], details: { via: "platinum" } };
      } catch (e) {
        // The op stays in the ledger as failed rather than vanishing: "it
        // errored" and "it never ran" are different states after a crash.
        log.finish(toolCallId, "error", String(e.message ?? e));
        throw e;
      }
    },
  });

  return [
    tool("bash", "Bash (Platinum sandbox)",
      "Run a shell command in the workspace sandbox.",
      Type.Object({
        command: Type.String(),
        timeout: Type.Optional(Type.Number({ description: "seconds" })),
      }),
      async ({ command, timeout }) => {
        // The route accepts a string and wraps it as ['sh','-c',v] itself, and
        // takes MILLISECONDS with a 300 s ceiling.
        const timeout_ms = Math.min(Math.max(Math.round((timeout ?? 120) * 1000), 100), 300_000);
        const r = await api.call("POST", "/exec", { body: { cmd: command, timeout_ms } });
        const res = r.result ?? {};
        return `${res.stdout ?? ""}${res.stderr ?? ""}\n[exit ${res.exit_code ?? (res.ok ? 0 : -1)}]` +
               (res.error ? `\n[error ${res.error}]` : "");
      }),

    tool("read", "Read file (Platinum sandbox)",
      "Read a file from the workspace sandbox.",
      Type.Object({
        path: Type.String(),
        offset: Type.Optional(Type.Number()),
        limit: Type.Optional(Type.Number()),
      }),
      async ({ path, offset, limit }) => {
        const r = await api.call("GET", "/files", { query: { path, offset, limit }, raw: true });
        if (r.status >= 400) throw new Error(`read ${path} -> ${r.status}: ${r.text.slice(0, 200)}`);
        return r.text;
      }),

    tool("write", "Write file (Platinum sandbox)",
      "Write a file in the workspace sandbox.",
      Type.Object({ path: Type.String(), content: Type.String() }),
      async ({ path, content }) => {
        await api.call("PUT", "/files", { query: { path }, body: { content } });
        return `wrote ${path}`;
      }),

    tool("list", "List directory (Platinum sandbox)",
      "List a directory in the workspace sandbox.",
      Type.Object({ path: Type.Optional(Type.String()) }),
      async ({ path }) => {
        const r = await api.call("GET", "/files/list", { query: { path: path ?? "/" } });
        const entries = r.entries ?? r.files ?? [];
        return entries.map((e) => (typeof e === "string" ? e : `${e.type === "dir" ? "d" : "-"} ${e.name ?? e.path}`)).join("\n") || "(empty)";
      }),

    tool("grep", "Grep (Platinum sandbox)",
      "Search file contents in the workspace sandbox.",
      Type.Object({
        pattern: Type.String(),
        path: Type.Optional(Type.String()),
        max: Type.Optional(Type.Number()),
      }),
      async ({ pattern, path, max }) => {
        const r = await api.call("GET", "/files/grep", { query: { pattern, path: path ?? "/", max } });
        const hits = r.matches ?? r.results ?? [];
        return hits.map((m) => (typeof m === "string" ? m : `${m.path}:${m.line ?? ""}: ${m.text ?? ""}`)).join("\n") || "(no matches)";
      }),
  ];
}
