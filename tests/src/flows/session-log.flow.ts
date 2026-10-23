/**
 * The session-log journal ingest and manifest (P2.2), called the way kortixd's
 * journal calls them: a session-bound PAT (the sandbox's `KORTIX_TOKEN`) and a
 * gzipped JSON body. Maps to spec §7 `SLOG-1`. The operator switch (503) needs
 * the API's env and is covered in
 * apps/api/src/__tests__/integration-session-log-ingest.test.ts.
 * `SLOG-2` is the read path (P4.2, P8.2): a mirror-only session converted by its
 * first read, the same v1 reads after the journal writes the log, and `GET …/log`. `SLOG-3` is the restore claim (P6.1); its operator
 * switch (503) is covered in
 * apps/api/src/__tests__/integration-session-log-restore.test.ts.
 * `SLOG-4` is the switch preflight (P7.1): the loss report of a stored log on another harness.
 */
import { createHash } from "node:crypto";
import {
  fromV1,
  SessionLogJournalResponseSchema,
  SessionLogManifestSchema,
  SessionLogPageSchema,
  SessionLogRestoreMissingSchema,
  SessionLogRestoreSchema,
  SessionLogSwitchPreflightSchema,
  type SessionLogRestore,
  type V1Row,
} from "@kortix/api-contract/session-log";
import { Client } from "pg";
import type { FlowContext } from "../core/types";
import { flow } from "../core/flow";
import { CliSandbox, throwIfCliInfraFailure } from "../fixtures/cli";
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

/**
 * The credential a session sandbox holds: an account token bound to the project and the
 * session, live while the session's sandbox row is (the session lease). `close` deletes
 * the sandbox row (no reaper reads a row without an external_id) and the connection.
 */
async function sandboxCredential(ctx: FlowContext, projectId: string, sessionId: string) {
  const minted = await ctx.client.as(ctx.P.OWNER).post("/v1/accounts/tokens", { name: "Session log journal", account_id: ctx.P.OWNER.accountId });
  minted.status(201);
  const credential = minted.json<{ token_id: string; secret_key: string }>();
  const db = new Client({ connectionString: ctx.env.databaseUrl!, ssl: /localhost|127\.0\.0\.1/.test(ctx.env.databaseUrl!) ? false : { rejectUnauthorized: false } });
  await db.connect();
  await db.query("UPDATE kortix.account_tokens SET project_id = $2, session_id = $3 WHERE token_id = $1", [credential.token_id, projectId, sessionId]);
  await db.query("INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status) VALUES ($1::uuid, $1, $2, $3, 'active')", [sessionId, ctx.P.OWNER.accountId, projectId]);
  return {
    secret: credential.secret_key,
    box: ctx.client.withBearer(credential.secret_key, "SESSION_SANDBOX"),
    close: async () => {
      await db.query("DELETE FROM kortix.session_sandboxes WHERE session_id = $1 AND external_id IS NULL", [sessionId]).catch(() => {});
      await db.end().catch(() => {});
    },
  };
}

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

    const { box, close } = await sandboxCredential(ctx, project.id, sessionId);
    try {
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

      await ctx.step("a put that reuses a seq its thread holds → 422 with the offending pair and the thread's seq_max, nothing written", async () => {
        (await post(batch(1, [{ rev: REV + 5, message: message("msg_dup", 1) }])))
          .status(422)
          .body()
          .has("$", { error: "seq_conflict", message_id: "msg_dup", rev: REV + 5, thread_id: "main", seq: 1, seq_max: 2 });
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
      await close();
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
    routes: [
      "POST /v1/accounts/tokens", `POST ${JOURNAL}`, `GET ${TRANSCRIPT}`, `GET ${BUNDLE}`, `GET ${LOG}`,
      // `kortix sessions log` logs in and locates the session before it reads the log.
      "GET /v1/accounts/me", "GET /v1/projects/:projectId/sessions/:sessionId",
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    const accountId = ctx.P.OWNER.accountId!;
    const sessionId = await createDatabaseSession(ctx.env, { projectId: project.id, accountId, userId: ctx.P.OWNER.userId! });
    ctx.track("session", sessionId, { projectId: project.id });
    const child = `ses_${sessionId.replaceAll("-", "").slice(0, 20)}child`;
    // An old session: its history only in the v1 mirror, as the pre-journal capture stored it.
    const { root, messages } = await seedSessionTranscript(ctx.env, {
      projectId: project.id, accountId, sessionId, ensureSandbox: false,
      messages: (r) => syntheticConversation(r, child, 6),
    });
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: project.id, sessionId };
    const { box, secret, close } = await sandboxCredential(ctx, project.id, sessionId);

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
      let converted: Awaited<ReturnType<typeof v1Reads>>;
      await ctx.step("the first read of the mirror-only session converts it into the log: every v1 read answers, and the open bundle's log leg holds the root thread", async () => {
        converted = await v1Reads();
        if (converted.bodies.length < 6) throw new Error(`expected at least 3 sync pages, got ${converted.bodies.length - 3}`);
        const leg = converted.log as { known: boolean; page: { thread_id: string; messages: unknown[]; has_more: boolean } | null };
        if (!leg?.known || leg.page?.thread_id !== root || leg.page.messages.length === 0) throw new Error(`log leg: ${JSON.stringify(leg)?.slice(0, 300)}`);
      });

      await ctx.step("the session daemon then journals fromV1 of the same rows under producer opencode → 200, every message acknowledged", async () => {
        const rows = messages.map((m) => ({ runtime_session_id: (m.info.sessionID as string) ?? root, info: m.info, parts: m.parts })) as unknown as V1Row[];
        const log = fromV1({ session_id: sessionId, root_id: root, rows }, { harness: "opencode" });
        const producer = { harness: "opencode", harness_version: "1.18.23", adapter_version: "1.0.0" };
        const { threads, ...session } = log;
        const puts = threads.flatMap((t) => t.messages.map((m, i) => ({ rev: REV + i, message: { ...m, producer } })));
        const body = Bun.gzipSync(JSON.stringify({ generation: 0, session, threads: threads.map(({ messages: _m, ...t }) => t), puts, tombstones: [] }));
        (await box.post(JOURNAL, body, { params, raw: true, headers: { "content-type": "application/json", "content-encoding": "gzip" } }))
          .status(200).body().has("$.acked.length", puts.length);
      });

      await ctx.step("the journal's log answers the same v1 bodies as the converted mirror, apart from captured_at", async () => {
        const journaled = await v1Reads();
        for (let i = 0; i < converted!.bodies.length; i++) {
          if (!Bun.deepEquals(journaled.bodies[i], converted!.bodies[i])) throw new Error(`v1 read ${i} differs after the journal:\n${JSON.stringify(journaled.bodies[i])}\n---\n${JSON.stringify(converted!.bodies[i])}`);
        }
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

      await ctx.step("the real CLI prints the stored log as kortix.session/2 JSON: every thread, the same messages as GET …/log; text from its blocks", async () => {
        const page = (await owner.get(LOG, { params, query: { limit: 500 } })).status(200).json<{ threads: Array<{ thread_id: string }>; thread_id: string; messages: Array<{ message_id: string }> }>();
        const childPage = (await owner.get(LOG, { params, query: { thread: child, limit: 500 } })).status(200).json<{ messages: Array<{ message_id: string }> }>();
        const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name("cli-slog") });
        const cli = new CliSandbox("slog");
        try {
          const login = await cli.login(pat, { noProject: true, account: ctx.P.OWNER.accountId });
          if (login.exitCode !== 0) throw new Error(`kortix login exited ${login.exitCode}: ${login.all}`);
          const run = await cli.run(["sessions", "log", sessionId, "--project", project.id, "--json", "--limit", "500"]);
          throwIfCliInfraFailure(run, "kortix sessions log --json");
          if (run.exitCode !== 0) throw new Error(`kortix sessions log exited ${run.exitCode}: ${run.all}`);
          const out = JSON.parse(run.stdout) as { schema: string; source: string; threads: Array<{ thread_id: string; messages: Array<{ message_id: string }>; has_more: boolean }> };
          if (out.schema !== "kortix.session/2" || out.source !== "log") throw new Error(`schema ${out.schema}, source ${out.source}`);
          const ids = (list: Array<{ message_id: string }>) => list.map((m) => m.message_id).join();
          if (out.threads.map((t) => t.thread_id).join() !== page.threads.map((t) => t.thread_id).join()) throw new Error(`threads ${out.threads.map((t) => t.thread_id)} vs ${page.threads.map((t) => t.thread_id)}`);
          const rootOut = out.threads.find((t) => t.thread_id === page.thread_id)!;
          const childOut = out.threads.find((t) => t.thread_id === child)!;
          if (ids(rootOut.messages) !== ids(page.messages) || rootOut.has_more) throw new Error(`root thread differs from GET …/log: ${ids(rootOut.messages)}`);
          if (ids(childOut.messages) !== ids(childPage.messages)) throw new Error(`child thread differs from GET …/log: ${ids(childOut.messages)}`);
          if (!run.stderr.includes("Stored session log")) throw new Error(`log did not name its source: ${run.stderr}`);

          const human = await cli.run(["sessions", "log", sessionId, "--project", project.id, "--limit", "3"]);
          if (human.exitCode !== 0) throw new Error(`human sessions log exited ${human.exitCode}: ${human.all}`);
          if (!human.stdout.includes("[bash · complete]") || !human.stdout.includes("Turn 5: file-5.txt.")) throw new Error(`human output: ${human.stdout}`);
        } finally {
          cli.dispose();
        }
      });

      await ctx.step("inside a sandbox (the session-bound KORTIX_TOKEN) GET …/log → 200 with the owner's body, and the real CLI exits 0 and prints the stored log, source log", async () => {
        const page = (await owner.get(LOG, { params, query: { limit: 500 } })).status(200).json<{ threads: Array<{ thread_id: string }>; thread_id: string; messages: Array<{ message_id: string }> }>();
        const boxPage = (await box.get(LOG, { params, query: { limit: 500 } })).status(200).json();
        if (JSON.stringify(boxPage) !== JSON.stringify(page)) throw new Error("the session-bound token read another body than the owner");
        const cli = new CliSandbox("slog-box");
        try {
          const run = await cli.run(["sessions", "log", sessionId, "--json", "--limit", "500"], { env: { KORTIX_TOKEN: secret, KORTIX_PROJECT_ID: project.id } });
          throwIfCliInfraFailure(run, "kortix sessions log (session-bound token)");
          if (run.exitCode !== 0) throw new Error(`kortix sessions log exited ${run.exitCode}: ${run.all}`);
          const out = JSON.parse(run.stdout) as { schema: string; source: string; threads: Array<{ thread_id: string; messages: Array<{ message_id: string }> }> };
          if (out.schema !== "kortix.session/2" || out.source !== "log") throw new Error(`schema ${out.schema}, source ${out.source}`);
          if (out.threads.map((t) => t.thread_id).join() !== page.threads.map((t) => t.thread_id).join()) throw new Error(`threads ${out.threads.map((t) => t.thread_id)} vs ${page.threads.map((t) => t.thread_id)}`);
          const rootOut = out.threads.find((t) => t.thread_id === page.thread_id)!;
          if (rootOut.messages.map((m) => m.message_id).join() !== page.messages.map((m) => m.message_id).join()) throw new Error("root thread differs from GET …/log");
          if (!run.stderr.includes("Stored session log")) throw new Error(`log did not name its source: ${run.stderr}`);
        } finally {
          cli.dispose();
        }
      });

      await ctx.step("a bad before_seq → 400; an unknown thread → 404", async () => {
        (await owner.get(LOG, { params, query: { before_seq: "x" } })).status(400);
        (await owner.get(LOG, { params, query: { thread: "ses_not_a_thread" } })).status(404);
      });
    } finally {
      await close();
    }
  },
);

const RESTORE = "/v1/projects/:projectId/sessions/:sessionId/log/restore";
const ATTACHMENT = "/v1/projects/:projectId/sessions/:sessionId/attachments/:attachmentId";

flow(
  "SLOG-3",
  {
    domain: "sessions",
    requires: ["database"],
    routes: ["POST /v1/accounts/tokens", `POST ${JOURNAL}`, `POST ${RESTORE}`, `GET ${ATTACHMENT}`],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    const sessionId = await createDatabaseSession(ctx.env, { projectId: project.id, accountId: ctx.P.OWNER.accountId!, userId: ctx.P.OWNER.userId! });
    ctx.track("session", sessionId, { projectId: project.id });
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: project.id, sessionId };
    const { box, close } = await sandboxCredential(ctx, project.id, sessionId);
    const post = (body: unknown) =>
      box.post(JOURNAL, Bun.gzipSync(JSON.stringify(body)), { params, raw: true, headers: { "content-type": "application/json", "content-encoding": "gzip" } });
    const thread = (id: string, parent: string | null) => ({ schema: "kortix.session/2", v: 1, thread_id: id, parent_thread_id: parent, spawned_by: null, agent: null, title: null, created_at: T, ext: {} });
    // A synthetic tool output over the 256 kB offload threshold.
    const output = "0123456789abcdef".repeat(20_000);
    const tool = { type: "tool_call", id: "prt_tool", call_id: "call_tool", name: "bash", kind: "shell", input: { command: "cat big.log" }, status: "complete", result: { content: [{ type: "text", text: output }], is_error: false } };
    const session = {
      schema: "kortix.session/2", v: 1, session_id: sessionId, title: "Synthetic restore", created_at: T, restore_grade: "native",
      harness: { current: "opencode", history: [] }, selection: { agent: null, model: null }, todos: [], pending: { questions: [], permissions: [] }, ext: {},
    };

    try {
      await ctx.step("a session without a stored log → 404 no_session_log, and the project owner's own token → 403", async () => {
        (await box.post(RESTORE, undefined, { params })).status(404).body().schema(SessionLogRestoreMissingSchema);
        (await owner.post(RESTORE, undefined, { params })).status(403);
      });

      await ctx.step("the box journals two threads at generation 0: a 320 kB tool output, an out-of-context message, a tombstone → 200", async () => {
        (await post({
          generation: 0, session, threads: [thread("main", null), thread("ses_child", "main")], tombstones: [],
          puts: [
            { rev: REV + 4, message: message("msg_u3", 3) },
            { rev: REV + 1, message: message("msg_u0", 0) },
            { rev: REV + 2, message: message("msg_a1", 1, { role: "assistant", finish: "tool_calls", blocks: [tool] }) },
            { rev: REV + 3, message: message("msg_old2", 2, { in_context: false, hidden_reason: "superseded" }) },
            { rev: REV + 5, message: message("msg_c0", 0, { thread_id: "ses_child" }) },
          ],
        })).status(200);
        (await post({ generation: 0, session: undefined, threads: [], puts: [], tombstones: [{ message_id: "msg_u3", rev: REV + 9 }] })).status(200);
      });

      let claimed: SessionLogRestore;
      await ctx.step("a fresh box claims the session → 200 gzipped: generation 1, live messages in seq order, every rev, one stored-by-reference text", async () => {
        const r = await box.post(RESTORE, undefined, { params, headers: { "accept-encoding": "gzip" } });
        r.status(200).body().schema(SessionLogRestoreSchema).has("$.generation", 1);
        if (r.header("content-encoding") !== "gzip") throw new Error(`content-encoding ${r.header("content-encoding")}, expected gzip`);
        claimed = r.json<SessionLogRestore>();
        const ids = claimed.log.threads.map((t) => [t.thread_id, t.messages.map((m) => m.message_id)]);
        const expected = [["main", ["msg_u0", "msg_a1", "msg_old2"]], ["ses_child", ["msg_c0"]]];
        if (JSON.stringify(ids) !== JSON.stringify(expected)) throw new Error(`threads ${JSON.stringify(ids)}, expected ${JSON.stringify(expected)}`);
        const revs = { msg_u0: REV + 1, msg_a1: REV + 2, msg_old2: REV + 3, msg_u3: REV + 9, msg_c0: REV + 5 };
        if (!Bun.deepEquals(claimed.revs, revs)) throw new Error(`revs ${JSON.stringify(claimed.revs)}`);
        const blob = claimed.blobs[0];
        if (claimed.blobs.length !== 1 || blob?.message_id !== "msg_a1" || blob.block_id !== "prt_tool" || blob.bytes !== output.length) throw new Error(`blobs ${JSON.stringify(claimed.blobs)}`);
      });

      await ctx.step("the box still journaling at generation 0 → 409 {generation:1}; a journal batch at generation 1 → 200", async () => {
        (await post({ generation: 0, threads: [], tombstones: [], puts: [{ rev: REV + 10, message: message("msg_zombie", 4) }] })).status(409).body().has("$", { generation: 1 });
        (await post({ generation: 1, threads: [], tombstones: [], puts: [{ rev: REV + 11, message: message("msg_u4", 4) }] })).status(200);
      });

      await ctx.step("the box reads the full text of the blob through the attachments route → 200, its sha256 matches", async () => {
        const blob = claimed!.blobs[0]!;
        const r = await box.get(ATTACHMENT, { params: { ...params, attachmentId: blob.ref.split("/").at(-1)! } });
        r.status(200);
        if (createHash("sha256").update(r.text()).digest("hex") !== blob.sha256) throw new Error("the attachment's sha256 differs from the blob's");
      });
    } finally {
      await close();
    }
  },
);

const PREFLIGHT = "/v1/projects/:projectId/sessions/:sessionId/log/switch-preflight";

flow(
  "SLOG-4",
  {
    domain: "sessions",
    requires: ["database"],
    routes: ["POST /v1/accounts/tokens", `POST ${JOURNAL}`, "PUT /v1/admin/api/projects/:id/features", `POST ${PREFLIGHT}`],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    const sessionId = await createDatabaseSession(ctx.env, { projectId: project.id, accountId: ctx.P.OWNER.accountId!, userId: ctx.P.OWNER.userId! });
    ctx.track("session", sessionId, { projectId: project.id });
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: project.id, sessionId };
    const preflight = (to: unknown, as = owner) => as.post(PREFLIGHT, { to }, { params });
    const { box, close } = await sandboxCredential(ctx, project.id, sessionId);
    const thread = (id: string, parent: string | null) => ({ schema: "kortix.session/2", v: 1, thread_id: id, parent_thread_id: parent, spawned_by: null, agent: null, title: null, created_at: T, ext: {} });
    const call = (id: string, name: string, kind: string) => ({ type: "tool_call", id, call_id: id, name, kind, input: {}, status: "complete", result: { content: [{ type: "text", text: "ok" }], is_error: false } });
    const pdf = { type: "attachment", id: "prt_pdf", mime: "application/pdf", ref: "blob:synthetic", bytes: 3, sha256: "a".repeat(64) };
    const session = {
      schema: "kortix.session/2", v: 1, session_id: sessionId, title: "Synthetic switch", created_at: T, restore_grade: "native",
      harness: { current: "opencode", history: [{ harness: "opencode", version: "1.18.23", from_seq: 1, at: T }] },
      selection: { agent: null, model: null }, todos: [{ content: "ship it", status: "pending" }], pending: { questions: [], permissions: [] }, ext: {},
    };

    try {
      await ctx.step("a session without a stored log → 404; a `to` that is not a harness → 400", async () => {
        (await preflight("pi")).status(404);
        (await preflight("claude-code")).status(400);
      });

      await ctx.step("the OpenCode box journals a sub-agent, a todo list, a PDF, an MCP tool, a rewound message → 200", async () => {
        (await box.post(JOURNAL, Bun.gzipSync(JSON.stringify({
          generation: 0, session, threads: [thread("main", null), thread("ses_child", "main")], tombstones: [],
          puts: [
            { rev: REV + 1, message: message("msg_u0", 0, { blocks: [{ type: "text", id: "prt_t", text: "read this" }, pdf] }) },
            { rev: REV + 2, message: message("msg_a1", 1, { role: "assistant", finish: "stop", blocks: [call("call_task", "task", "task"), call("call_todo", "todowrite", "todo"), call("call_mcp", "github_search", "mcp")] }) },
            { rev: REV + 3, message: message("msg_u2", 2, { in_context: false, hidden_reason: "reverted" }) },
            { rev: REV + 4, message: message("msg_c0", 0, { thread_id: "ses_child" }) },
          ],
        })), { params, raw: true, headers: { "content-type": "application/json", "content-encoding": "gzip" } })).status(200);
      });

      const losses = [
        { feature: "attachments.user", detail: "application/pdf", used: 1, status: "lost" },
        { feature: "todos", used: 1, status: "lost" },
        { feature: "session.rewind", used: 1, status: "lost" },
        { feature: "session.mcp", detail: "github_search", used: 1, status: "lost" },
      ];
      const unsupported = [
        { feature: "attachments.user", detail: "application/pdf", status: "lost" },
        { feature: "reasoning_replay", detail: "other_model", status: "lost" },
        { feature: "todos", status: "lost" },
        ...["session.rewind", "session.fork", "session.mcp", "session.todo", "session.shell", "session.attach", "session.config"].map((feature) => ({ feature, status: "lost" })),
      ];

      await ctx.step("restore off: preflight to pi → 200 available without a restore, and the whole history (4 live messages) is the first loss", async () => {
        (await preflight("pi")).status(200).body().schema(SessionLogSwitchPreflightSchema).has("$", {
          session_id: sessionId, from: "opencode", to: "pi", available: true, reason: null, restores: false,
          losses: [{ feature: "history", used: 4, status: "lost" }, ...losses], unsupported,
        });
      });

      await ctx.step("restore on: preflight to pi → 200 available; losses: the PDF, the todos, the rewind, the MCP tool (the sub-agent is native on pi); unsupported adds what was never used (fork, shell, attach, config)", async () => {
        await setFeatureAsOperator(ctx, project.id, "session_log_restore", true);
        (await preflight("pi")).status(200).body().schema(SessionLogSwitchPreflightSchema).has("$", {
          session_id: sessionId, from: "opencode", to: "pi", available: true, reason: null, restores: true, losses, unsupported,
        });
      });

      await ctx.step("preflight to opencode (the same harness) → 200 not available (same_harness), no loss; the read claimed nothing (a journal batch at generation 0 → 200)", async () => {
        (await preflight("opencode")).status(200).body().has("$.available", false).has("$.reason", "same_harness").has("$.losses", []).has("$.unsupported", []);
        (await box.post(JOURNAL, batch(0, [{ rev: REV + 5, message: message("msg_u3", 3) }]), { params, raw: true, headers: { "content-type": "application/json", "content-encoding": "gzip" } })).status(200);
      });

      await ctx.step("a converted log (no manifest: every feature native at the source) → pi: the SQL projection gives the JS rules: a tool-result image degraded, a layout compaction degraded, an opaque one lost, another model's reasoning that starts with blank lines lost", async () => {
        const converted = await createDatabaseSession(ctx.env, { projectId: project.id, accountId: ctx.P.OWNER.accountId!, userId: ctx.P.OWNER.userId! });
        ctx.track("session", converted, { projectId: project.id });
        const second = await sandboxCredential(ctx, project.id, converted);
        try {
          const at = { projectId: project.id, sessionId: converted };
          const image = { ...call("call_img", "screenshot", "other"), result: { content: [{ type: "attachment", mime: "image/png", ref: "blob:synthetic", sha256: "b".repeat(64) }], is_error: false } };
          const layout = { type: "compaction", id: "prt_layout", summary: "s", first_kept_message_id: null, layout: [{ summary: true }] };
          const opaque = { type: "compaction", id: "prt_opaque", summary: null, opaque: true, first_kept_message_id: null };
          const glm = { provider: "kortix", model: "glm-5.3-flash" };
          (await second.box.post(JOURNAL, Bun.gzipSync(JSON.stringify({
            generation: 0, threads: [thread("main", null)], tombstones: [],
            session: { ...session, session_id: converted, harness: { current: "kortix-v1-import", history: [] }, todos: [], selection: { agent: null, model: glm } },
            puts: [
              { rev: REV + 1, message: message("msg_x0", 0, { role: "assistant", finish: "stop", blocks: [image, layout, opaque] }) },
              { rev: REV + 2, message: message("msg_x1", 1, { role: "assistant", finish: "stop", model: { provider: "kortix", model: "other-model" }, blocks: [{ type: "reasoning", id: "prt_think", text: "\n\nthinking" }] }) },
              { rev: REV + 3, message: message("msg_x2", 2, { role: "assistant", finish: "stop", model: glm, blocks: [{ type: "reasoning", id: "prt_blank", text: "\n \t" }] }) },
            ],
          })), { params: at, raw: true, headers: { "content-type": "application/json", "content-encoding": "gzip" } })).status(200);
          (await owner.post(PREFLIGHT, { to: "pi" }, { params: at })).status(200).body().schema(SessionLogSwitchPreflightSchema).has("$.losses", [
            { feature: "attachments.tool_result", used: 1, status: "degraded" },
            { feature: "compaction", detail: "layout", used: 1, status: "degraded" },
            { feature: "compaction", detail: "opaque", used: 1, status: "lost" },
            { feature: "reasoning_replay", detail: "other_model", used: 1, status: "lost" },
          ]);
        } finally {
          await second.close();
        }
      });

      await ctx.step("a user with no membership in the project's account → 403, no report", async () => {
        (await preflight("pi", ctx.client.as(ctx.P.NONMEMBER))).status(403);
      });
    } finally {
      await setFeatureAsOperator(ctx, project.id, "session_log_restore", null).catch(() => {});
      await close();
    }
  },
);

const BLOB = "/v1/projects/:projectId/sessions/:sessionId/log/blobs/:sha256";

flow(
  "SLOG-5",
  {
    domain: "sessions",
    requires: ["database"],
    routes: ["POST /v1/accounts/tokens", `GET ${BLOB}`, `PUT ${BLOB}`, `POST ${JOURNAL}`, `GET ${LOG}`, `GET ${ATTACHMENT}`],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    const sessionId = await createDatabaseSession(ctx.env, { projectId: project.id, accountId: ctx.P.OWNER.accountId!, userId: ctx.P.OWNER.userId! });
    ctx.track("session", sessionId, { projectId: project.id });
    const owner = ctx.client.as(ctx.P.OWNER);
    const { box, close } = await sandboxCredential(ctx, project.id, sessionId);
    const params = { projectId: project.id, sessionId };
    // A synthetic image as UTF-8 text, so the flow client's text body round-trips it.
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>';
    const sha256 = createHash("sha256").update(svg).digest("hex");
    const at = { ...params, sha256 };
    const upload = (client: typeof box, sha = sha256) =>
      client.put(BLOB, new TextEncoder().encode(svg), { params: { ...params, sha256: sha }, raw: true, headers: { "content-type": "image/svg+xml" } });
    let ref = "";
    try {
      await ctx.step("the box asks for an attachment the session does not hold → 200 {ref:null}; the owner's own token → 403", async () => {
        (await box.get(BLOB, { params: at })).status(200).body().has("$", { ref: null });
        (await owner.get(BLOB, { params: at })).status(403);
        (await upload(owner)).status(403);
      });

      await ctx.step("an upload whose body sha256 is not the path's → 400 and nothing stored", async () => {
        (await upload(box, "0".repeat(64))).status(400);
        (await box.get(BLOB, { params: at })).status(200).body().has("$", { ref: null });
      });

      await ctx.step("the box uploads the bytes → 200 {ref} in its session folder; a second upload and the lookup answer the same ref", async () => {
        const r = await upload(box);
        r.status(200);
        ref = r.json<{ ref: string }>().ref;
        if (!ref.startsWith(`kortix-attachment://${project.id}/${sessionId}/`)) throw new Error(`ref ${ref}`);
        (await upload(box)).status(200).body().has("$", { ref });
        (await box.get(BLOB, { params: at })).status(200).body().has("$", { ref });
      });

      await ctx.step("a journaled record naming the object → 200; GET …/log serves the attachment with ref, sha256 and bytes", async () => {
        const image = { type: "attachment", id: "prt_img", ref, mime: "image/svg+xml", bytes: svg.length, sha256 };
        const body = { generation: 0, threads: [], tombstones: [], puts: [{ rev: REV + 1, message: message("msg_img", 0, { blocks: [image] }) }] };
        (await box.post(JOURNAL, Bun.gzipSync(JSON.stringify(body)), { params, raw: true, headers: { "content-type": "application/json", "content-encoding": "gzip" } })).status(200);
        (await owner.get(LOG, { params })).status(200).body().has("$.messages[0].blocks[0]", image);
      });

      await ctx.step("the box reads the object back through the attachments route → 200 with the same sha256", async () => {
        const r = await box.get(ATTACHMENT, { params: { ...params, attachmentId: ref.split("/").at(-1)! } });
        r.status(200);
        if (createHash("sha256").update(r.text()).digest("hex") !== sha256) throw new Error("the object's sha256 differs from the upload's");
      });
    } finally {
      await close();
    }
  },
);
