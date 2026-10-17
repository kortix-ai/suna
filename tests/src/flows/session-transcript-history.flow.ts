import { SessionSnapshotSchema, SessionTranscriptSyncEnvelopeSchema } from "@kortix/api-contract";
import { Client } from "pg";
import { flow } from "../core/flow";
import type { FlowContext, FlowMeta, Principal } from "../core/types";
import { CliSandbox, throwIfCliInfraFailure } from "../fixtures/cli";
import { createDatabaseSession } from "../fixtures/database-project";
import { seedSessionTranscript } from "../fixtures/session-transcript";

type Store = "mirror" | "log";

/**
 * Registers `<id>` with the saved history in the v1 mirror (what every project reads today)
 * and `<id>-log` with it in the session log, written through the journal with the project's
 * `session_log` flag on (Session Log Plan P5.7). Both implement spec `<id>`.
 */
function storeFlow(id: string, meta: FlowMeta, fn: (ctx: FlowContext, store: Store) => Promise<void>): void {
  flow(id, meta, (ctx) => fn(ctx, "mirror"));
  flow(
    `${id}-log`,
    {
      ...meta,
      specId: id,
      routes: [
        ...(meta.routes ?? []),
        "POST /v1/accounts/tokens",
        "DELETE /v1/accounts/tokens/:tokenId",
        "POST /v1/projects/:projectId/sessions/:sessionId/log/journal",
      ],
    },
    (ctx) => fn(ctx, "log"),
  );
}

/** The fixture's `log` option for `store`: the owner's current token mints the journal credential. */
async function logOption(store: Store, owner: Principal) {
  if (store === "mirror") return {};
  if (owner.auth.mode !== "bearer") throw new Error(`the -log twin needs a bearer owner to journal, got auth mode ${owner.auth.mode}`);
  await owner.auth.ensureFresh?.();
  return { log: { bearer: owner.auth.token } };
}

storeFlow(
  "SESS-32",
  {
    domain: "sessions",
    requires: ["database"],
    routes: [
      "GET /v1/projects/:projectId/sessions/:sessionId/transcript",
      "PATCH /v1/projects/:projectId/features",
      // `kortix sessions digest` lists, then digests each session.
      "GET /v1/projects/:projectId/sessions",
      "GET /v1/accounts/me",
      // `kortix sessions log` locates the session, asks for its stored session
      // log (404: none), then reads its saved copy.
      "GET /v1/projects/:projectId/sessions/:sessionId",
      "GET /v1/projects/:projectId/sessions/:sessionId/log",
      "GET /v1/projects/:projectId/sessions/:sessionId/snapshot",
    ],
  },
  async (ctx, store) => {
    const project = await ctx.fixtures.project();
    const sessionId = await createDatabaseSession(ctx.env, {
      projectId: project.id,
      accountId: ctx.P.OWNER.accountId!,
      userId: ctx.P.OWNER.userId!,
    });
    ctx.track("session", sessionId, { projectId: project.id });
    const child = "ses_subagentwindow";
    const fixture = await seedSessionTranscript(ctx.env, {
      projectId: project.id,
      accountId: ctx.P.OWNER.accountId!,
      sessionId,
      // The prompt and the reply, which dispatched a sub-agent (a `task` call naming its
      // runtime session), and the sub-agent's first message in that session.
      messages: (root, [prompt, reply]) => [
        prompt!,
        {
          ...reply!,
          parts: [
            ...reply!.parts,
            {
              id: "prt_history_task", sessionID: root, messageID: reply!.info.id, type: "tool", callID: "call_history_task", tool: "task",
              state: { status: "completed", input: { description: "List", prompt: "List the files." }, output: "", title: "List", metadata: { sessionId: child }, time: { start: 1, end: 2 } },
            },
          ],
        },
        {
          info: { id: "msg_subagent_000000000000001", sessionID: child, role: "user", time: { created: Date.now() - 30_000 } },
          parts: [{ id: "prt_subagent", sessionID: child, messageID: "msg_subagent_000000000000001", type: "text", text: "List the files." }],
        },
      ],
      ...(await logOption(store, ctx.P.OWNER)),
    });
    const route = "/v1/projects/:projectId/sessions/:sessionId/transcript";
    const options = {
      params: { projectId: project.id, sessionId },
      query: { shape: "sync", history: "true" },
    };
    const owner = ctx.client.as(ctx.P.OWNER);
    await ctx.step(
      "a stopped session's saved messages read from PostgreSQL without waking it, in the contract shape",
      async () => {
        (await owner.get(route, options))
          .status(200)
          .body()
          .has("$.source", "mirror")
          .has("$.available", true)
          .has("$.message_count", 2)
          .schema(SessionTranscriptSyncEnvelopeSchema);
      },
    );
    await ctx.step(
      "the session snapshot answers the same saved window in one read, every leg in the contract shape",
      async () => {
        (
          await owner.get("/v1/projects/:projectId/sessions/:sessionId/snapshot", {
            params: { projectId: project.id, sessionId },
          })
        )
          .status(200)
          .body()
          .has("$.session.session_id", sessionId)
          .has("$.transcript.known", true)
          .has("$.transcript.message_count", 2)
          .has("$.turn.known", true)
          .has("$.queue.known", true)
          .schema(SessionSnapshotSchema);
      },
    );
    await ctx.step(
      "saved history has no off switch: the retired flag answers 400 and a stored off override changes nothing",
      async () => {
        (
          await owner.patch(
            "/v1/projects/:projectId/features",
            { feature: "session_transcript_history", enabled: false },
            { params: { projectId: project.id } },
          )
        )
          .status(400)
          .body()
          .has("$.error", "Unknown feature flag 'session_transcript_history'");
        // What an older server wrote when a project turned the flag off.
        const db = new Client({ connectionString: ctx.env.databaseUrl! });
        // A dropped connection must fail the next query, not crash the runner.
        db.on("error", () => {});
        await db.connect();
        try {
          await db.query(
            `UPDATE kortix.projects SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('experimental', COALESCE(metadata->'experimental', '{}'::jsonb) || '{"session_transcript_history":false}'::jsonb) WHERE project_id = $1`,
            [project.id],
          );
        } finally {
          await db.end();
        }
        (await owner.get(route, options))
          .status(200)
          .body()
          .has("$.source", "mirror")
          .has("$.available", true)
          .has("$.message_count", 2)
          .has("$.opencode_session_id", fixture.root)
          .has(
            "$.messages[1].info.time.completed",
            fixture.messages[1].info.time.completed,
          )
          .has(
            "$.messages[1].parts[0].text",
            "This reply is stored in the database.",
          );
      },
    );
    await ctx.step(
      "a sub-agent's saved transcript is its own window, and the conversation never includes it",
      async () => {
        (await owner.get(route, options))
          .status(200)
          .body()
          .has("$.message_count", 2)
          .has("$.total", 2);
        (await owner.get(route, { ...options, query: { ...options.query, child } }))
          .status(200)
          .body()
          .has("$.available", true)
          .has("$.opencode_session_id", child)
          .has("$.message_count", 1)
          .has("$.messages[0].parts[0].text", "List the files.");
        (
          await owner.get(route, { ...options, query: { ...options.query, child: "not-a-session" } })
        ).status(400);
        (
          await owner.get(route, { ...options, query: { ...options.query, child: "ses_nothingsaved" } })
        )
          .status(200)
          .body()
          .has("$.available", false)
          .has("$.message_count", 0);
      },
    );
    await ctx.step(
      "anonymous and nonmember callers cannot read stored session messages",
      async () => {
        (await ctx.client.as(ctx.P.ANON).get(route, options)).status(401);
        (await ctx.client.as(ctx.P.NONMEMBER).get(route, options)).status([
          403, 404,
        ]);
      },
    );
    await ctx.step(
      "a replaced root makes the old transcript unavailable without waking a sandbox",
      async () => {
        const db = new Client({ connectionString: ctx.env.databaseUrl! });
        // A dropped connection must fail the next query, not crash the runner.
        db.on("error", () => {});
        await db.connect();
        try {
          await db.query(
            "UPDATE kortix.project_sessions SET opencode_session_id = $2 WHERE session_id = $1",
            [sessionId, "ses_replacement"],
          );
        } finally {
          await db.end();
        }
        (await owner.get(route, options))
          .status(200)
          .body()
          .has("$.available", false)
          .has("$.message_count", 0)
          .has("$.opencode_session_id", "ses_replacement");
      },
    );
    await ctx.step(
      "the real CLI digests the stopped session's saved transcript",
      async () => {
        // `kortix sessions digest` used to refuse any session that was not
        // `running` and never make the request.
        //
        // Put the root back first. The step above replaced it to prove the SYNC
        // shape refuses a mirror it cannot attribute; the compact shape the CLI
        // reads carries no such check, so leaving `ses_replacement` in place
        // would make this step pass for a reason it is not testing.
        const restore = new Client({ connectionString: ctx.env.databaseUrl! });
        await restore.connect();
        try {
          await restore.query(
            "UPDATE kortix.project_sessions SET opencode_session_id = $2 WHERE session_id = $1",
            [sessionId, fixture.root],
          );
        } finally {
          await restore.end();
        }
        const pat = await ctx.fixtures.pat({
          name: ctx.fixtures.name("cli-digest"),
        });
        const cli = new CliSandbox("digest");
        try {
          const login = await cli.login(pat, {
            noProject: true,
            account: ctx.P.OWNER.accountId,
          });
          if (login.exitCode !== 0)
            throw new Error(`kortix login exited ${login.exitCode}: ${login.all}`);
          const run = await cli.run([
            "sessions",
            "digest",
            "--project",
            project.id,
            "--all",
            "--json",
          ]);
          throwIfCliInfraFailure(run, "kortix sessions digest");
          if (run.exitCode !== 0)
            throw new Error(`kortix sessions digest exited ${run.exitCode}: ${run.all}`);
          const payload = JSON.parse(run.stdout) as {
            sessions: Array<{
              session: { session_id: string; status: string };
              transcript: {
                available: boolean;
                source: string;
                complete: boolean;
                message_count: number;
                messages: Array<{ role: string; text: string }>;
              };
            }>;
          };
          const digest = payload.sessions.find(
            (row) => row.session.session_id === sessionId,
          );
          if (!digest) throw new Error(`digest omitted session ${sessionId}`);
          if (digest.session.status === "running")
            throw new Error("fixture session must be stopped for this assertion");
          if (!digest.transcript.available)
            throw new Error(
              `stopped session reported no transcript: ${JSON.stringify(digest.transcript)}`,
            );
          if (digest.transcript.source !== "mirror")
            throw new Error(`expected source 'mirror', got '${digest.transcript.source}'`);
          if (digest.transcript.complete !== true)
            throw new Error("a head-complete mirror must report complete");
          if (digest.transcript.message_count !== 2)
            throw new Error(`expected 2 messages, got ${digest.transcript.message_count}`);
          const reply = digest.transcript.messages.find((m) => m.role === "assistant");
          if (!reply?.text.includes("stored in the database"))
            throw new Error(`digest lost the saved reply: ${JSON.stringify(reply)}`);
        } finally {
          cli.dispose();
        }
      },
    );
    await ctx.step(
      "the real CLI reads a stopped session's conversation from its saved transcript without waking it",
      async () => {
        // `kortix sessions log` used to refuse any session that was not running
        // and tell the user to restart it — a paid, minutes-long wake just to
        // read text the server already held.
        const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name("cli-log") });
        const cli = new CliSandbox("log");
        try {
          const login = await cli.login(pat, { noProject: true, account: ctx.P.OWNER.accountId });
          if (login.exitCode !== 0)
            throw new Error(`kortix login exited ${login.exitCode}: ${login.all}`);
          const run = await cli.run([
            "sessions",
            "log",
            sessionId,
            "--project",
            project.id,
            "--json",
          ]);
          throwIfCliInfraFailure(run, "kortix sessions log");
          if (run.exitCode !== 0)
            throw new Error(`kortix sessions log exited ${run.exitCode}: ${run.all}`);
          // Mirror: no stored session log, so the saved v1 transcript converted to
          // the kortix.session/2 records (one thread: the root), so scripts read one
          // shape. Log: the stored session log, every thread. The source is
          // reported on stderr so it cannot break them.
          const expected = store === "log"
            ? { source: "log", threads: [fixture.root, child], stderr: "Stored session log" }
            : { source: "v1", threads: [fixture.root], stderr: "Saved transcript" };
          const log = JSON.parse(run.stdout) as {
            schema: string;
            source: string;
            threads: Array<{ thread_id: string; messages: Array<{ role: string; blocks: Array<{ type: string; text?: string }> }> }>;
          };
          if (log.schema !== "kortix.session/2" || log.source !== expected.source)
            throw new Error(`expected schema kortix.session/2 from source ${expected.source}: ${run.stdout.slice(0, 300)}`);
          const messages = log.threads[0]?.messages ?? [];
          if (log.threads.map((t) => t.thread_id).join() !== expected.threads.join() || messages.length !== 2)
            throw new Error(`expected threads ${expected.threads}, the root with the 2 saved messages; got ${JSON.stringify(log.threads.map((t) => [t.thread_id, t.messages.length]))}`);
          if (messages[0]!.role !== "user" || messages[1]!.role !== "assistant")
            throw new Error(`saved messages out of order: ${run.stdout}`);
          if (!messages[1]!.blocks.some((b) => b.type === "text" && b.text?.includes("stored in the database")))
            throw new Error(`log lost the saved reply: ${run.stdout}`);
          if (!run.stderr.includes(expected.stderr))
            throw new Error(`log did not say where the messages came from: ${run.stderr}`);
          // The old v1 JSON, for one release: the message array, and a deprecation note on stderr.
          const old = await cli.run(["sessions", "log", sessionId, "--project", project.id, "--json", "--schema", "v1"]);
          throwIfCliInfraFailure(old, "kortix sessions log --schema v1");
          if (old.exitCode !== 0) throw new Error(`--schema v1 exited ${old.exitCode}: ${old.all}`);
          const array = JSON.parse(old.stdout) as Array<{ role: string; text: string }>;
          if (array.length !== 2 || !array[1]!.text.includes("stored in the database"))
            throw new Error(`--schema v1 lost the old shape: ${old.stdout}`);
          if (!old.stderr.includes("deprecated"))
            throw new Error(`--schema v1 did not say it is deprecated: ${old.stderr}`);
          const status = (await owner.get("/v1/projects/:projectId/sessions/:sessionId", {
            params: { projectId: project.id, sessionId },
          })).status(200).json<{ status: string }>();
          if (status.status !== "stopped")
            throw new Error(`reading the log changed the session to '${status.status}'`);
        } finally {
          cli.dispose();
        }
      },
    );
    await ctx.step(
      "a stopped session with nothing saved yet exits 1 and says how to read it live",
      async () => {
        const unsaved = await createDatabaseSession(ctx.env, {
          projectId: project.id,
          accountId: ctx.P.OWNER.accountId!,
          userId: ctx.P.OWNER.userId!,
        });
        ctx.track("session", unsaved, { projectId: project.id });
        const db = new Client({ connectionString: ctx.env.databaseUrl! });
        // A dropped connection must fail the next query, not crash the runner.
        db.on("error", () => {});
        await db.connect();
        try {
          await db.query(
            "UPDATE kortix.project_sessions SET status = 'stopped' WHERE session_id = $1",
            [unsaved],
          );
        } finally {
          await db.end();
        }
        const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name("cli-log-none") });
        const cli = new CliSandbox("log-none");
        try {
          const login = await cli.login(pat, { noProject: true, account: ctx.P.OWNER.accountId });
          if (login.exitCode !== 0)
            throw new Error(`kortix login exited ${login.exitCode}: ${login.all}`);
          const run = await cli.run(["sessions", "log", unsaved, "--project", project.id]);
          throwIfCliInfraFailure(run, "kortix sessions log (nothing saved)");
          if (run.exitCode !== 1)
            throw new Error(`expected exit 1 with nothing saved, got ${run.exitCode}: ${run.all}`);
          if (!run.stderr.includes("No saved transcript") || !run.stderr.includes("sessions start"))
            throw new Error(`nothing-saved message did not guide the user: ${run.stderr}`);
        } finally {
          cli.dispose();
        }
      },
    );
  },
);

storeFlow(
  "SESS-31",
  {
    domain: "sessions",
    tags: ["deployed"],
    requires: ["database"],
    routes: [
      "POST /v1/projects/:projectId/sessions/:sessionId/attachments",
      "GET /v1/projects/:projectId/sessions/:sessionId/attachments/:attachmentId",
      "POST /v1/projects/:projectId/sessions/:sessionId/prompts",
      "DELETE /v1/projects/:projectId/sessions/:sessionId",
      // `kortix sessions attachments` logs in, locates the session, reads its
      // saved transcript as the index, then fetches the bytes.
      "GET /v1/accounts/me",
      "GET /v1/projects/:projectId/sessions/:sessionId",
      "GET /v1/projects/:projectId/sessions/:sessionId/transcript",
    ],
  },
  async (ctx, store) => {
    const project = await ctx.fixtures.project();
    const sessionId = await createDatabaseSession(ctx.env, {
      projectId: project.id,
      accountId: ctx.P.OWNER.accountId!,
      userId: ctx.P.OWNER.userId!,
    });
    const siblingId = await createDatabaseSession(ctx.env, {
      projectId: project.id,
      accountId: ctx.P.OWNER.accountId!,
      userId: ctx.P.OWNER.userId!,
    });
    for (const id of [sessionId, siblingId])
      ctx.track("session", id, { projectId: project.id });
    const owner = ctx.client.as(ctx.P.OWNER);
    const attachmentId = crypto.randomUUID();
    const params = { projectId: project.id, sessionId, attachmentId };
    const upload = "/v1/projects/:projectId/sessions/:sessionId/attachments";
    const download = `${upload}/:attachmentId`;
    const ref = `kortix-attachment://${project.id}/${sessionId}/${attachmentId}`;
    const contents = "Files remain readable while the computer is stopped.";
    const form = (bytes: BlobPart = contents) => {
      const body = new FormData();
      body.append("attachment_id", attachmentId);
      body.append(
        "file",
        new Blob([bytes], { type: "text/plain" }),
        "notes.txt",
      );
      return body;
    };
    await ctx.step(
      "attachments require authentication and project membership",
      async () => {
        (
          await ctx.client
            .as(ctx.P.ANON)
            .request("POST", upload, { params, body: form() })
        ).status(401);
        (
          await ctx.client
            .as(ctx.P.NONMEMBER)
            .request("POST", upload, { params, body: form() })
        ).status([403, 404]);
      },
    );
    await ctx.step(
      "save and read exact bytes without a sandbox, retry the immutable upload, and ignore a stored off override",
      async () => {
        // What an older server wrote when a project turned saved history off.
        // Saved history has no off switch now, so the upload still succeeds.
        const db = new Client({ connectionString: ctx.env.databaseUrl! });
        // A dropped connection must fail the next query, not crash the runner.
        db.on("error", () => {});
        await db.connect();
        try {
          await db.query(
            `UPDATE kortix.projects SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"experimental":{"session_transcript_history":false}}'::jsonb WHERE project_id = $1`,
            [project.id],
          );
        } finally {
          await db.end();
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          (await owner.request("POST", upload, { params, body: form() }))
            .status(201)
            .body()
            .has("$.url", ref)
            .has("$.filename", "notes.txt")
            .has("$.mime", "text/plain")
            .has("$.size", contents.length);
        }
        const response = (await owner.get(download, { params }))
          .status(200)
          .headerEquals("cache-control", "private, no-store")
          .headerEquals("x-content-type-options", "nosniff");
        if (response.text() !== contents)
          throw new Error("Downloaded attachment bytes differ");
        (
          await owner.request("POST", upload, {
            params,
            body: form("replacement"),
          })
        ).status(409);
        (
          await owner.request("POST", upload, {
            params,
            body: form(new Uint8Array(50 * 1024 * 1024 + 1)),
          })
        ).status(413);
      },
    );
    await ctx.step(
      "anonymous, nonmember, and sibling sessions cannot read or submit this attachment",
      async () => {
        (await ctx.client.as(ctx.P.ANON).get(download, { params })).status(401);
        (await ctx.client.as(ctx.P.NONMEMBER).get(download, { params })).status(
          [403, 404],
        );
        (
          await owner.get(download, {
            params: { ...params, sessionId: siblingId },
          })
        ).status(404);
        (
          await owner.post(
            "/v1/projects/:projectId/sessions/:sessionId/prompts",
            {
              client_message_id: crypto.randomUUID(),
              message_id: "msg_0123456789abAbCdEfGhIjKlMn",
              parts: [
                {
                  type: "file",
                  filename: "notes.txt",
                  mime: "text/plain",
                  url: ref,
                },
              ],
            },
            { params: { ...params, sessionId: siblingId } },
          )
        )
          .status(400)
          .body()
          .has("$.error", "Attachment belongs to another session");
      },
    );
    await ctx.step(
      "the real CLI lists and downloads a stopped session's stored file without its sandbox",
      async () => {
        // The saved transcript is the index of what a session stored. Seed one
        // whose user message references the uploaded file, stop the session,
        // and read it back through `kortix sessions attachments`.
        await seedSessionTranscript(ctx.env, {
          projectId: project.id,
          accountId: ctx.P.OWNER.accountId!,
          sessionId,
          ensureSandbox: false,
          messages: (root) => [
            {
              info: { id: "msg_attach_000000000000001", sessionID: root, role: "user", time: { created: Date.now() - 1_000 } },
              parts: [
                { id: "prt_text", type: "text", text: "Here are my notes." },
                { id: "prt_file", type: "file", filename: "notes.txt", mime: "text/plain", url: ref },
              ],
            },
          ],
          ...(await logOption(store, ctx.P.OWNER)),
        });
        const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name("cli-attachments") });
        const cli = new CliSandbox("attachments");
        try {
          const login = await cli.login(pat, { noProject: true, account: ctx.P.OWNER.accountId });
          if (login.exitCode !== 0)
            throw new Error(`kortix login exited ${login.exitCode}: ${login.all}`);

          const listed = await cli.run([
            "sessions", "attachments", sessionId, "--project", project.id, "--json",
          ]);
          throwIfCliInfraFailure(listed, "kortix sessions attachments");
          if (listed.exitCode !== 0)
            throw new Error(`kortix sessions attachments exited ${listed.exitCode}: ${listed.all}`);
          const list = JSON.parse(listed.stdout) as {
            source: string;
            attachments: Array<{ attachment_id: string; filename: string; url: string; role: string }>;
          };
          if (list.source !== "saved") throw new Error(`expected source 'saved', got '${list.source}'`);
          if (list.attachments.length !== 1)
            throw new Error(`expected 1 stored file, got ${list.attachments.length}: ${listed.stdout}`);
          const [only] = list.attachments;
          if (only!.attachment_id !== attachmentId || only!.url !== ref || only!.filename !== "notes.txt")
            throw new Error(`listed the wrong file: ${listed.stdout}`);

          const out = `${cli.cwd}/downloads`;
          const fetched = await cli.run([
            "sessions", "attachments", sessionId, "--project", project.id,
            "--download", attachmentId, "--out", out, "--json",
          ]);
          throwIfCliInfraFailure(fetched, "kortix sessions attachments --download");
          if (fetched.exitCode !== 0)
            throw new Error(`download exited ${fetched.exitCode}: ${fetched.all}`);
          const result = JSON.parse(fetched.stdout) as {
            downloaded: Array<{ path: string; bytes: number }>;
          };
          const written = result.downloaded[0]!;
          if (written.path !== `${out}/notes.txt`)
            throw new Error(`wrote to an unexpected path: ${written.path}`);
          const bytes = await Bun.file(written.path).text();
          if (bytes !== contents)
            throw new Error(`downloaded bytes differ from the stored file: ${JSON.stringify(bytes)}`);

          // A second download never overwrites the first.
          const again = await cli.run([
            "sessions", "attachments", sessionId, "--project", project.id,
            "--download", attachmentId, "--out", out, "--json",
          ]);
          if (again.exitCode !== 0) throw new Error(`second download exited ${again.exitCode}: ${again.all}`);
          const second = (JSON.parse(again.stdout) as { downloaded: Array<{ path: string }> }).downloaded[0]!;
          if (second.path !== `${out}/notes (1).txt`)
            throw new Error(`second download did not take a free name: ${second.path}`);

          // Reading the conversation says the file is fetchable, and how.
          const log = await cli.run(["sessions", "log", sessionId, "--project", project.id]);
          if (log.exitCode !== 0) throw new Error(`sessions log exited ${log.exitCode}: ${log.all}`);
          if (!log.stdout.includes("notes.txt") || !log.stdout.includes("kortix sessions attachments"))
            throw new Error(`the log does not lead to the stored file: ${log.stdout}`);

          // An id the transcript does not reference is refused, not fetched.
          const unknown = await cli.run([
            "sessions", "attachments", sessionId, "--project", project.id,
            "--download", crypto.randomUUID(),
          ]);
          if (unknown.exitCode !== 1 || !unknown.stderr.includes("No stored file"))
            throw new Error(`unknown id was not refused: ${unknown.exitCode} ${unknown.all}`);

          const session = (await owner.get("/v1/projects/:projectId/sessions/:sessionId", { params }))
            .status(200)
            .json<{ status: string }>();
          if (session.status !== "stopped")
            throw new Error(`listing or downloading changed the session to '${session.status}'`);
        } finally {
          cli.dispose();
        }
      },
    );
    await ctx.step(
      "deleting the session denies every read and keeps its stored bytes for a restore until the retention purge",
      async () => {
        (
          await owner.request(
            "DELETE",
            "/v1/projects/:projectId/sessions/:sessionId",
            { params },
          )
        ).status(200);
        (await owner.get(download, { params })).status(404);
        const db = new Client({ connectionString: ctx.env.databaseUrl! });
        // A dropped connection must fail the next query, not crash the runner.
        db.on("error", () => {});
        await db.connect();
        try {
          const result = await db.query(
            "SELECT count(*)::int AS count FROM storage.objects WHERE bucket_id='session-attachments' AND name=$1",
            [`${project.id}/${sessionId}/${attachmentId}`],
          );
          // KRTX-1734: the session is restorable for 30 days, so its file is
          // kept. The purge deletes it 37 days after the delete (SESS-51).
          if (result.rows[0].count !== 1)
            throw new Error(`a deleted session's file should stay until the purge, found ${result.rows[0].count}`);
        } finally {
          await db.end();
        }
      },
    );
  },
);
