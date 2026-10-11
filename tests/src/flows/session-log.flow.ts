/**
 * The session-log journal ingest and manifest (P2.2), called the way kortixd's
 * journal calls them: a session-bound PAT (the sandbox's `KORTIX_TOKEN`) and a
 * gzipped JSON body. Maps to spec §7 `SLOG-1`. The operator switch (503) needs
 * the API's env and is covered in
 * apps/api/src/__tests__/integration-session-log-ingest.test.ts.
 */
import { SessionLogJournalResponseSchema, SessionLogManifestSchema } from "@kortix/api-contract/session-log";
import { Client } from "pg";
import { flow } from "../core/flow";
import { createDatabaseSession } from "../fixtures/database-project";

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
    try {
      await db.query("UPDATE kortix.account_tokens SET project_id = $2, session_id = $3 WHERE token_id = $1", [credential.token_id, project.id, sessionId]);
    } finally {
      await db.end().catch(() => {});
    }
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
  },
);
