import { Client } from "pg";
import { flow } from "../core/flow";
import { createDatabaseSession } from "../fixtures/database-project";
import { seedSessionTranscript } from "../fixtures/session-transcript";

flow(
  "SESS-32",
  {
    domain: "sessions",
    requires: ["database"],
    routes: [
      "GET /v1/projects/:projectId/sessions/:sessionId/transcript",
      "PATCH /v1/projects/:projectId/features",
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    const sessionId = await createDatabaseSession(ctx.env, {
      projectId: project.id,
      accountId: ctx.P.OWNER.accountId!,
      userId: ctx.P.OWNER.userId!,
    });
    ctx.track("session", sessionId, { projectId: project.id });
    const fixture = await seedSessionTranscript(ctx.env, {
      projectId: project.id,
      accountId: ctx.P.OWNER.accountId!,
      sessionId,
    });
    const route = "/v1/projects/:projectId/sessions/:sessionId/transcript";
    const options = {
      params: { projectId: project.id, sessionId },
      query: { shape: "sync", history: "true" },
    };
    const owner = ctx.client.as(ctx.P.OWNER);
    await ctx.step(
      "the default flag rejects early history with 403",
      async () => {
        (await owner.get(route, options))
          .status(403)
          .body()
          .has("$.code", "feature_disabled");
      },
    );
    await ctx.step(
      "enable history through the project flag API and read completed stored messages while stopped",
      async () => {
        (
          await owner.patch(
            "/v1/projects/:projectId/features",
            { feature: "session_transcript_history", enabled: true },
            { params: { projectId: project.id } },
          )
        ).status(200);
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
      "disabling the flag denies the opt-in read again",
      async () => {
        (
          await owner.patch(
            "/v1/projects/:projectId/features",
            { feature: "session_transcript_history", enabled: false },
            { params: { projectId: project.id } },
          )
        ).status(200);
        (await owner.get(route, options)).status(403);
      },
    );
  },
);

flow(
  "SESS-31",
  {
    domain: "sessions",
    requires: ["database"],
    routes: [
      "POST /v1/projects/:projectId/sessions/:sessionId/attachments",
      "GET /v1/projects/:projectId/sessions/:sessionId/attachments/:attachmentId",
      "POST /v1/projects/:projectId/sessions/:sessionId/prompts",
      "DELETE /v1/projects/:projectId/sessions/:sessionId",
      "PATCH /v1/projects/:projectId/features",
    ],
  },
  async (ctx) => {
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
    const setFlag = async (enabled: boolean) =>
      (
        await owner.patch(
          "/v1/projects/:projectId/features",
          { feature: "session_transcript_history", enabled },
          { params },
        )
      ).status(200);
    await ctx.step(
      "attachments require authentication and the explicit project flag",
      async () => {
        (
          await ctx.client
            .as(ctx.P.ANON)
            .request("POST", upload, { params, body: form() })
        ).status(401);
        (await owner.request("POST", upload, { params, body: form() }))
          .status(403)
          .body()
          .has("$.code", "feature_disabled");
        await setFlag(true);
        (
          await ctx.client
            .as(ctx.P.NONMEMBER)
            .request("POST", upload, { params, body: form() })
        ).status([403, 404]);
      },
    );
    await ctx.step(
      "save and read exact bytes without a sandbox and retry the immutable upload",
      async () => {
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
      "disabling new uploads keeps existing attachments readable",
      async () => {
        await setFlag(false);
        (await owner.request("POST", upload, { params, body: form() })).status(
          403,
        );
        const response = (await owner.get(download, { params })).status(200);
        if (response.text() !== contents)
          throw new Error("Disabling the flag removed saved bytes");
      },
    );
    await ctx.step(
      "deleting the session removes its stored bytes and denies subsequent reads",
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
        await db.connect();
        try {
          const result = await db.query(
            "SELECT count(*)::int AS count FROM storage.objects WHERE bucket_id='session-attachments' AND name=$1",
            [`${project.id}/${sessionId}/${attachmentId}`],
          );
          if (result.rows[0].count !== 0)
            throw new Error("Deleted session still owns attachment bytes");
        } finally {
          await db.end();
        }
      },
    );
  },
);
