/**
 * The session-log journal ingest and manifest (P2.2), called the way kortixd's
 * journal calls them: a session-bound PAT (the sandbox's `KORTIX_TOKEN`) and a
 * gzipped JSON body. Maps to spec §7 `SLOG-1`. The operator switch (503) needs
 * the API's env and is covered in
 * apps/api/src/__tests__/integration-session-log-ingest.test.ts.
 * `SLOG-2` is the read path (P4.2): the v1 reads with the `session_log` flag
 * off and on, and `GET …/log`.
 */
import { fromV1, SessionLogJournalResponseSchema, SessionLogManifestSchema, SessionLogPageSchema, type V1Row } from "@kortix/api-contract/session-log";
import { Client } from "pg";
import { flow } from "../core/flow";
import { createDatabaseSession } from "../fixtures/database-project";
import { setFeatureAsOperator } from "../fixtures/feature-flags";
import { seedSessionTranscript } from "../fixtures/session-transcript";

const JOURNAL = "/v1/projects/:projectId/sessions/:sessionId/log/journal";
const MANIFEST = "/v1/projects/:projectId/sessions/:sessionId/log/manifest";
const REV = 1_791_681_474_704_000;
const T = "2026-10-11T10:00:00.000Z";

const message = (id: string, seq: number, over: Record<string, unknown> = {}) => ({
  schema: "kortix.session/2", v: 1, message_id: id, thread_id: "main", seq,
  role: "user", kind: "turn", status: "complete", in_context: true,
  model: null, usage: null, finish: null, error: null, created_at: T, completed_at: null,
  producer: { harness: "opencode", harness_version: "1.18.15", adapter_version: "1" }, blocks: [], ext: {}, ...over,
});
const batch = (generation: number, puts: Array<{ rev: number; message: unknown }>) =>
  Bun.gzipSync(JSON.stringify({ generation, puts, tombstones: [], threads: [] }));

flow(
  "SLOG-1",
  {
    domain: "sessions",
    requires: ["database"],
    routes: ["POST /v1/accounts/tokens", `POST ${JOURNAL}`, `GET ${MANIFEST}`],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    const sessionId = await createDatabaseSession(ctx.env, {
      projectId: project.id,
      accountId: ctx.P.OWNER.accountId!,
      userId: ctx.P.OWNER.userId!,
    });
    ctx.track("session", sessionId, { projectId: project.id });
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: project.id, sessionId };

    // The credential a session sandbox holds: an account token bound to the project and the session.
    const minted = await owner.post("/v1/accounts/tokens", { name: "Session log journal", account_id: ctx.P.OWNER.accountId });
    minted.status(201);
    const credential = minted.json<{ token_id: string; secret_key: string }>();
    const db = new Client({ connectionString: ctx.env.databaseUrl!, ssl: /localhost|127\.0\.0\.1/.test(ctx.env.databaseUrl!) ? false : { rejectUnauthorized: false } });
    await db.connect();
    await db.query("UPDATE kortix.account_tokens SET project_id = $2, session_id = $3 WHERE token_id = $1", [credential.token_id, project.id, sessionId]);
    // A session PAT authenticates only while its sandbox row is live (the session lease).
    await db.query("INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status) VALUES ($1::uuid, $1, $2, $3, 'active')", [sessionId, ctx.P.OWNER.accountId, project.id]);
    try {
      const box = ctx.client.withBearer(credential.secret_key, "SESSION_SANDBOX");
      const post = (body: Uint8Array) =>
        box.post(JOURNAL, body, { params, raw: true, headers: { "content-type": "application/json", "content-encoding": "gzip" } });

      const first = batch(0, [
        { rev: REV + 1, message: message("msg_u1", 0) },
        { rev: REV + 2, message: message("msg_a1", 1, { role: "assistant", reply_to: "msg_u1", finish: "stop", completed_at: T }) },
      ]);
      const acked = [{ message_id: "msg_u1", rev: REV + 1 }, { message_id: "msg_a1", rev: REV + 2 }];

      await ctx.step("the session sandbox journals a two-message batch → 200 with both (message_id, rev) pairs acknowledged", async () => {
        const r = await post(first);
        r.status(200).body().schema(SessionLogJournalResponseSchema).has("$.acked", acked);
      });

      await ctx.step("a replay of the same batch → 200 with the same pairs, and the manifest still lists two messages", async () => {
        (await post(first)).status(200).body().has("$.acked", acked);
        (await box.get(MANIFEST, { params })).status(200).body().has("$.messages.length", 2);
      });

      await ctx.step("a newer generation is accepted; a batch from the older one → 409 with the current generation", async () => {
        (await post(batch(1, [{ rev: REV + 3, message: message("msg_u2", 2) }]))).status(200);
        (await post(batch(0, [{ rev: REV + 4, message: message("msg_zombie", 3) }]))).status(409).body().has("$", { generation: 1 });
      });

      await ctx.step("a put that reuses a seq its thread holds → 422 with the offending pair, nothing written", async () => {
        (await post(batch(1, [{ rev: REV + 5, message: message("msg_dup", 1) }])))
          .status(422)
          .body()
          .has("$", { error: "seq_conflict", message_id: "msg_dup", rev: REV + 5, thread_id: "main", seq: 1 });
      });

      await ctx.step("the manifest lists the generation and each stored message with its rev as a JSON number", async () => {
        const r = await box.get(MANIFEST, { params });
        r.status(200).body().schema(SessionLogManifestSchema).has("$.generation", 1);
        const listed = r.json<{ messages: Array<{ message_id: string; rev: unknown; deleted: boolean }> }>().messages;
        const pairs = JSON.stringify(listed.map((m) => [m.message_id, m.rev, m.deleted]));
        const expected = JSON.stringify([["msg_u1", REV + 1, false], ["msg_a1", REV + 2, false], ["msg_u2", REV + 3, false]]);
        if (pairs !== expected) throw new Error(`manifest lists ${pairs}, expected ${expected}`);
      });

      await ctx.step("the project owner's own token is not the session sandbox credential → 403 on both routes", async () => {
        (await owner.post(JOURNAL, first, { params, raw: true, headers: { "content-encoding": "gzip" } })).status(403);
        (await owner.get(MANIFEST, { params })).status(403);
      });
    } finally {
      // No reaper reads a sandbox row without an external_id: a leaked `active` row stays forever.
      await db.query("DELETE FROM kortix.session_sandboxes WHERE session_id = $1 AND external_id IS NULL", [sessionId]).catch(() => {});
      await db.end().catch(() => {});
    }
  },
);

/**
 * A small synthetic OpenCode conversation for the read flows: a prompt and a
 * reply per turn with steps, reasoning, a bash call and a patch; a `task` call
 * whose sub-agent session holds two messages; a manual compaction with its
 * summary. Every value is invented.
 */
function syntheticConversation(root: string, child: string, turns: number) {
  let n = 0;
  const id = (p: string) => `${p}_${String(++n).padStart(12, "0")}`;
  const at = () => 1_790_000_000_000 + n * 1_000;
  const model = { providerID: "kortix", modelID: "synthetic-model" };
  const part = (sid: string, mid: string, p: Record<string, unknown>) => ({ id: id("prt"), sessionID: sid, messageID: mid, ...p });
  const user = (sid: string, text: string, kind: "text" | "compaction" = "text") => {
    const mid = id("msg");
    const info = { id: mid, sessionID: sid, role: "user", time: { created: at() }, agent: "build", model };
    return { info, parts: [part(sid, mid, kind === "text" ? { type: "text", text } : { type: "compaction", auto: false })] };
  };
  const reply = (sid: string, parentID: string, parts: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => {
    const mid = id("msg");
    const created = at();
    const info = {
      id: mid, sessionID: sid, role: "assistant", parentID, time: { created, completed: created + 500 }, ...model, mode: "build", agent: "build",
      path: { cwd: "/workspace", root: "/workspace" }, cost: 0.001, tokens: { input: 900, output: 60, reasoning: 8, cache: { read: 100, write: 0 } }, finish: "stop", ...extra,
    };
    return { info, parts: parts.map((p) => part(sid, mid, p)) };
  };
  const rows: Array<{ info: Record<string, unknown> & { id: string; role: string; time: { created: number; completed?: number } }; parts: Array<Record<string, unknown>> }> = [];
  for (let i = 0; i < turns; i++) {
    const u = user(root, `Prompt ${i}: list the files.`);
    rows.push(u);
    if (i === 2) {
      const marker = user(root, "", "compaction");
      rows.push(marker, reply(root, marker.info.id, [{ type: "text", text: "SUMMARY of turns 0-2." }], { mode: "compaction", agent: "compaction", summary: true }));
    }
    const t = at();
    const tools: Array<Record<string, unknown>> = [{ type: "tool", callID: `call_${t}`, tool: "bash", state: { status: "completed", input: { command: `ls dir${i}` }, output: `file-${i}.txt`, title: `ls dir${i}`, metadata: { exit: 0 }, time: { start: t, end: t + 20 } } }];
    if (i === 1) {
      tools.push({ type: "tool", callID: `call_task_${t}`, tool: "task", state: { status: "completed", input: { description: "list", prompt: "List the files." }, output: `task_id: ${child}`, title: "list", metadata: { sessionId: child }, time: { start: t, end: t + 300 } } });
      const cu = user(child, "List the files.");
      rows.push(cu, reply(child, cu.info.id, [{ type: "text", text: "README.md" }]));
    }
    rows.push(reply(root, u.info.id, [
      { type: "step-start", snapshot: `s${i}` }, { type: "reasoning", text: `Turn ${i}.`, time: { start: t, end: t + 5 } }, ...tools,
      { type: "text", text: `Turn ${i}: file-${i}.txt.` }, { type: "patch", hash: `h${i}`, files: [`/workspace/file-${i}.txt`] },
      { type: "step-finish", reason: "stop", snapshot: `s${i}b`, cost: 0.0005, tokens: { input: 900 + i, output: 60, reasoning: 8, cache: { read: 100, write: 0 } } },
    ]));
  }
  return rows;
}

const TRANSCRIPT = "/v1/projects/:projectId/sessions/:sessionId/transcript";
const BUNDLE = "/v1/projects/:projectId/sessions/:sessionId/open-bundle";
const LOG = "/v1/projects/:projectId/sessions/:sessionId/log";

flow(
  "SLOG-2",
  {
    domain: "sessions",
    requires: ["database"],
    routes: ["POST /v1/accounts/tokens", `POST ${JOURNAL}`, "PUT /v1/admin/api/projects/:id/features", `GET ${TRANSCRIPT}`, `GET ${BUNDLE}`, `GET ${LOG}`],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    const accountId = ctx.P.OWNER.accountId!;
    const sessionId = await createDatabaseSession(ctx.env, { projectId: project.id, accountId, userId: ctx.P.OWNER.userId! });
    ctx.track("session", sessionId, { projectId: project.id });
    const child = `ses_${sessionId.replaceAll("-", "").slice(0, 20)}child`;
    // The mirror rows, as the transcript capture stores them.
    const { root, messages } = await seedSessionTranscript(ctx.env, {
      projectId: project.id, accountId, sessionId, ensureSandbox: false,
      messages: (r) => syntheticConversation(r, child, 6),
    });
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: project.id, sessionId };
    const minted = await owner.post("/v1/accounts/tokens", { name: "Session log journal", account_id: accountId });
    minted.status(201);
    const credential = minted.json<{ token_id: string; secret_key: string }>();
    const db = new Client({ connectionString: ctx.env.databaseUrl!, ssl: /localhost|127\.0\.0\.1/.test(ctx.env.databaseUrl!) ? false : { rejectUnauthorized: false } });
    await db.connect();
    await db.query("UPDATE kortix.account_tokens SET project_id = $2, session_id = $3 WHERE token_id = $1", [credential.token_id, project.id, sessionId]);
    await db.query("INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status) VALUES ($1::uuid, $1, $2, $3, 'active')", [sessionId, accountId, project.id]);
    const box = ctx.client.withBearer(credential.secret_key, "SESSION_SANDBOX");

    /** Every v1 read with `captured_at` set aside: the sync pages of 4 to the end, the child, compact, the bundle's transcript leg. */
    const v1Reads = async () => {
      const bodies: unknown[] = [];
      const strip = (b: Record<string, unknown>) => {
        const { captured_at: _c, ...rest } = b;
        return rest;
      };
      let before: string | null = null;
      do {
        const r = await owner.get(TRANSCRIPT, { params, query: { shape: "sync", limit: 4, ...(before && { before }) } });
        r.status(200);
        const body = r.json<Record<string, unknown>>();
        bodies.push(strip(body));
        before = body.next_cursor as string | null;
      } while (before);
      bodies.push(strip((await owner.get(TRANSCRIPT, { params, query: { shape: "sync", child } })).status(200).json()));
      bodies.push(strip((await owner.get(TRANSCRIPT, { params, query: { limit: 50, detail: "full" } })).status(200).json()));
      const bundle = (await owner.get(BUNDLE, { params })).status(200).json<Record<string, Record<string, unknown>>>();
      bodies.push(strip(bundle.transcript!));
      return { bodies, log: bundle.log };
    };

    try {
      await ctx.step("the session daemon journals fromV1 of the same rows under producer opencode → 200, every message acknowledged", async () => {
        const rows = messages.map((m) => ({ runtime_session_id: (m.info.sessionID as string) ?? root, info: m.info, parts: m.parts })) as unknown as V1Row[];
        const log = fromV1({ session_id: sessionId, root_id: root, rows }, { harness: "opencode" });
        const producer = { harness: "opencode", harness_version: "1.18.23", adapter_version: "1.0.0" };
        const { threads, ...session } = log;
        const puts = threads.flatMap((t) => t.messages.map((m, i) => ({ rev: REV + i, message: { ...m, producer } })));
        const body = Bun.gzipSync(JSON.stringify({ generation: 0, session, threads: threads.map(({ messages: _m, ...t }) => t), puts, tombstones: [] }));
        (await box.post(JOURNAL, body, { params, raw: true, headers: { "content-type": "application/json", "content-encoding": "gzip" } }))
          .status(200).body().has("$.acked.length", puts.length);
      });

      let off: Awaited<ReturnType<typeof v1Reads>>;
      await ctx.step("flag off: the v1 reads answer from the mirror, and the open bundle has no log leg", async () => {
        off = await v1Reads();
        if (off.bodies.length < 6) throw new Error(`expected at least 3 sync pages, got ${off.bodies.length - 3}`);
        if (off.log !== undefined) throw new Error("the open bundle carries a log leg with the flag off");
      });

      await ctx.step("an operator enables session_log; the same reads answer the same bodies from the log, apart from captured_at", async () => {
        await setFeatureAsOperator(ctx, project.id, "session_log", true);
        const on = await v1Reads();
        for (let i = 0; i < off!.bodies.length; i++) {
          if (!Bun.deepEquals(on.bodies[i], off!.bodies[i])) throw new Error(`v1 read ${i} differs with the flag on:\n${JSON.stringify(on.bodies[i])}\n---\n${JSON.stringify(off!.bodies[i])}`);
        }
        const leg = on.log as { known: boolean; page: { thread_id: string; messages: unknown[]; has_more: boolean } };
        if (!leg?.known || leg.page.thread_id !== root || leg.page.messages.length === 0) throw new Error(`log leg: ${JSON.stringify(leg)?.slice(0, 300)}`);
      });

      await ctx.step("GET …/log pages the root thread backwards by seq and reads the child thread by thread=", async () => {
        const first = (await owner.get(LOG, { params, query: { limit: 5 } })).status(200);
        first.body().schema(SessionLogPageSchema).has("$.thread_id", root).has("$.has_more", true).has("$.messages.length", 5);
        const seqs = first.json<{ messages: Array<{ seq: number }> }>().messages.map((m) => m.seq);
        const older = (await owner.get(LOG, { params, query: { limit: 5, before_seq: seqs[0]! } })).status(200);
        const olderSeqs = older.json<{ messages: Array<{ seq: number }> }>().messages.map((m) => m.seq);
        if (Math.max(...olderSeqs) >= seqs[0]! || olderSeqs.join() !== [...olderSeqs].sort((a, b) => a - b).join()) throw new Error(`older page ${olderSeqs} after ${seqs}`);
        (await owner.get(LOG, { params, query: { thread: child } })).status(200).body().has("$.thread_id", child).has("$.messages.length", 2).has("$.has_more", false);
      });

      await ctx.step("the session sandbox credential cannot read the log → 403; a bad before_seq → 400; an unknown thread → 404", async () => {
        (await box.get(LOG, { params })).status(403);
        (await owner.get(LOG, { params, query: { before_seq: "x" } })).status(400);
        (await owner.get(LOG, { params, query: { thread: "ses_not_a_thread" } })).status(404);
      });
    } finally {
      await setFeatureAsOperator(ctx, project.id, "session_log", null).catch(() => {});
      await db.query("DELETE FROM kortix.session_sandboxes WHERE session_id = $1 AND external_id IS NULL", [sessionId]).catch(() => {});
      await db.end().catch(() => {});
    }
  },
);
