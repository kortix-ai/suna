/**
 * Session attachment admission — the deterministic control-plane half of
 * SESS-27. Browser evidence owns attachment tiles, reload timestamps, and turn
 * duration. The focused API tests own runtime write-failure injection. This
 * flow proves that the public warm-session claim boundary durably accepts one
 * ordered mixed batch before runtime readiness and leaves the unused session
 * retryable when staged non-native bytes are absent.
 */
import { flow } from "../core/flow";
import { createHash } from "node:crypto";
import { createDatabaseSession } from "../fixtures/database-project";

const attachmentNames = ["README.md", "probe.ts", "probe.zip", "probe.png"];
const promptText = "SESS-27 staged mixed attachment prompt";

const stagedParts = [
  { type: "text", text: promptText },
  {
    type: "file",
    mime: "text/markdown",
    filename: "README.md",
    url: "data:text/markdown;base64,IyBBdHRhY2htZW50IHByb2JlCg==",
  },
  {
    type: "file",
    mime: "application/typescript",
    filename: "probe.ts",
    url: "data:application/typescript;base64,ZXhwb3J0IGNvbnN0IGF0dGFjaG1lbnRQcm9iZSA9IHRydWU7Cg==",
  },
  {
    type: "file",
    mime: "application/zip",
    filename: "probe.zip",
    url: "data:application/zip;base64,UEsDBAoAAAAAAF0lIl1/dU9UEwAAABMAAAAJABwAUkVBRE1FLm1kVVQJAAP6W5dq+luXanV4CwABBPUBAAAEFAAAACMgQXR0YWNobWVudCBwcm9iZQpQSwMECgAAAAAAXSUiXVJLTVolAAAAJQAAAAgAHABwcm9iZS50c1VUCQAD+luXavpbl2p1eAsAAQT1AQAABBQAAABleHBvcnQgY29uc3QgYXR0YWNobWVudFByb2JlID0gdHJ1ZTsKUEsBAh4DCgAAAAAAXSUiXX91T1QTAAAAEwAAAAkAGAAAAAAAAQAAAKSBAAAAAFJFQURNRS5tZFVUBQAD+luXanV4CwABBPUBAAAEFAAAAFBLAQIeAwoAAAAAAF0lIl1SS01aJQAAACUAAAAIABgAAAAAAAEAAACkgVYAAABwcm9iZS50c1VUBQAD+luXanV4CwABBPUBAAAEFAAAAFBLBQYAAAAAAgACAJ0AAAC9AAAAAAA=",
  },
  {
    type: "file",
    mime: "image/png",
    filename: "probe.png",
    url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  },
];

flow(
  "SESS-27",
  {
    domain: "sessions",
    requires: ["database"],
    timeoutMs: 300_000,
    routes: [
      "POST /v1/projects/:projectId/sessions/warm/claim",
      "GET /v1/projects/:projectId/sessions/:sessionId",
      "GET /v1/projects/:projectId/sessions/:sessionId/prompts",
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    const retrySessionId = await createDatabaseSession(ctx.env, {
      projectId: project.id,
      accountId: ctx.P.OWNER.accountId!,
      userId: ctx.P.OWNER.userId!,
      metadata: { warm: true },
    });
    const sessionId = await createDatabaseSession(ctx.env, {
      projectId: project.id,
      accountId: ctx.P.OWNER.accountId!,
      userId: ctx.P.OWNER.userId!,
      metadata: { warm: true },
    });
    ctx.track("session", sessionId, { projectId: project.id });
    ctx.track("session", retrySessionId, { projectId: project.id });

    await ctx.step(
      "claim an unused session with Markdown, source, ZIP, and PNG parts -> 200 before runtime readiness",
      async () => {
        const r = await owner.post(
          "/v1/projects/:projectId/sessions/warm/claim",
          {
            session_id: sessionId,
            pending_prompt: {
              text: promptText,
              parts: stagedParts,
              attachment_names: attachmentNames,
            },
          },
          { params: { projectId: project.id } },
        );
        r.status(200);
        const returnedId = r.json<any>()?.session_id;
        if (returnedId !== sessionId) {
          throw new Error(
            `warm claim returned ${String(returnedId)} instead of ${sessionId}`,
          );
        }
      },
    );

    await ctx.step(
      "read the new session -> the ordered attachment names persist without duplicating prompt bytes in metadata",
      async () => {
        const r = await owner.get(
          "/v1/projects/:projectId/sessions/:sessionId",
          {
            params: { projectId: project.id, sessionId },
          },
        );
        r.status(200);
        const pending = r.json<any>()?.metadata?.pending_prompt;
        if (
          JSON.stringify(pending?.attachment_names) !==
          JSON.stringify(attachmentNames)
        ) {
          throw new Error(
            `pending attachment order changed: ${JSON.stringify(pending?.attachment_names)}`,
          );
        }
        if (
          Object.hasOwn(pending ?? {}, "text") ||
          Object.hasOwn(pending ?? {}, "parts")
        ) {
          throw new Error(
            "session metadata duplicated the durable prompt body",
          );
        }
      },
    );

    await ctx.step(
      "read the prompt inbox -> the pending-first row carries the accepted text and a live lifecycle state",
      async () => {
        const r = await owner.get(
          "/v1/projects/:projectId/sessions/:sessionId/prompts",
          {
            params: { projectId: project.id, sessionId },
          },
        );
        r.status(200);
        const prompt = (r.json<any>()?.prompts ?? []).find(
          (row: any) => row.client_message_id === `pending:${sessionId}`,
        );
        if (!prompt)
          throw new Error(
            "the pending-first prompt was not readable from the inbox",
          );
        if (prompt.text !== promptText) {
          throw new Error(
            `the pending-first prompt text changed: ${String(prompt.text)}`,
          );
        }
        if (
          !["queued", "delivering", "waiting", "failed"].includes(prompt.state)
        ) {
          throw new Error(
            `the pending-first prompt has an invalid state: ${String(prompt.state)}`,
          );
        }
        if (
          typeof prompt.prompt_id !== "string" ||
          prompt.prompt_id.length === 0
        ) {
          throw new Error("the pending-first prompt has no durable prompt_id");
        }
      },
    );

    await ctx.step(
      "claim with a remote ZIP -> 400, no partial prompt, and the unused session stays retryable",
      async () => {
        const rejected = await owner.post(
          "/v1/projects/:projectId/sessions/warm/claim",
          {
            session_id: retrySessionId,
            pending_prompt: {
              text: "SESS-27 rejected remote ZIP",
              parts: [
                { type: "text", text: "SESS-27 rejected remote ZIP" },
                {
                  type: "file",
                  mime: "application/zip",
                  filename: "remote.zip",
                  url: "https://files.example.test/remote.zip",
                },
              ],
              attachment_names: ["remote.zip"],
            },
          },
          { params: { projectId: project.id } },
        );
        rejected
          .status(400)
          .body()
          .matches("$.error", /must be uploaded before it can be sent/);

        const session = await owner.get(
          "/v1/projects/:projectId/sessions/:sessionId",
          {
            params: { projectId: project.id, sessionId: retrySessionId },
          },
        );
        session.status(200);
        const metadata = session.json<any>()?.metadata ?? {};
        if (metadata.warm !== true || metadata.pending_prompt !== undefined) {
          throw new Error(
            `failed claim changed the unused session: ${JSON.stringify(metadata)}`,
          );
        }

        const prompts = await owner.get(
          "/v1/projects/:projectId/sessions/:sessionId/prompts",
          {
            params: { projectId: project.id, sessionId: retrySessionId },
          },
        );
        prompts.status(200);
        if ((prompts.json<any>()?.prompts ?? []).length !== 0) {
          throw new Error("a rejected remote ZIP created a partial prompt");
        }

        const retry = await owner.post(
          "/v1/projects/:projectId/sessions/warm/claim",
          {
            session_id: retrySessionId,
            pending_prompt: {
              text: "SESS-27 valid retry",
              parts: [{ type: "text", text: "SESS-27 valid retry" }],
              attachment_names: [],
            },
          },
          { params: { projectId: project.id } },
        );
        retry.status(200).body().has("$.session_id", retrySessionId);
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
      "POST /v1/projects/:projectId/sessions/warm/claim",
      "GET /v1/projects/:projectId/sessions/:sessionId",
      "POST /v1/projects/:projectId/sessions/:sessionId/prompts",
      "POST /v1/projects/:projectId/sessions/:sessionId/prompts/hold",
      "GET /v1/projects/:projectId/sessions/:sessionId/prompts",
      "GET /v1/projects/:projectId/sessions/:sessionId/attachments/:sha256",
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    const sessionId = await createDatabaseSession(ctx.env, {
      projectId: project.id,
      accountId: ctx.P.OWNER.accountId!,
      userId: ctx.P.OWNER.userId!,
      metadata: { warm: true, pi_worker_boot: true, sandbox_slug: "pi-worker" },
    });
    ctx.track("session", sessionId, { projectId: project.id });
    const params = { projectId: project.id, sessionId };
    const content = `SESS-31 immutable bytes ${crypto.randomUUID()}`;
    const sha256 = createHash("sha256").update(content).digest("hex");
    const image = {
      type: "file",
      mime: "image/png",
      filename: "capture.png",
      url: `data:image/png;base64,${Buffer.from(content).toString("base64")}`,
    };
    const claim = (parts: unknown[]) =>
      owner.post(
        "/v1/projects/:projectId/sessions/warm/claim",
        {
          session_id: sessionId,
          pending_prompt: {
            text: "Read the image",
            parts,
            attachment_names: ["capture.png"],
          },
        },
        { params },
      );
    const readImage = () =>
      owner.get(
        "/v1/projects/:projectId/sessions/:sessionId/attachments/:sha256",
        { params: { ...params, sha256 } },
      );
    const readPrompts = () =>
      owner.get("/v1/projects/:projectId/sessions/:sessionId/prompts", {
        params,
      });

    await ctx.step(
      "hold the unused Pi session so attachment admission needs no runtime",
      async () => {
        (
          await owner.post(
            "/v1/projects/:projectId/sessions/:sessionId/prompts/hold",
            { held: true },
            { params },
          )
        ).status(200);
      },
    );
    await ctx.step(
      "an invalid image sibling rejects the claim without persisting bytes or consuming the warm session",
      async () => {
        (
          await claim([
            image,
            { ...image, url: "http://example.test/image.png" },
          ])
        ).status(400);
        (await readImage()).status(404);
        const session = await owner.get(
          "/v1/projects/:projectId/sessions/:sessionId",
          { params },
        );
        session.status(200).body().has("$.metadata.warm", true);
        if ((await readPrompts()).json<any>().prompts.length !== 0)
          throw new Error("invalid claim created a prompt");
      },
    );
    await ctx.step(
      "claim with a staged image commits an immutable asset and one pending prompt together",
      async () => {
        (await claim([{ type: "text", text: "Read the image" }, image])).status(
          200,
        );
        const response = await readImage();
        response.status(200);
        if (
          response.text() !== content ||
          response.header("content-type") !== "image/png"
        )
          throw new Error("stored image bytes or MIME changed");
        const prompts = await readPrompts();
        prompts.status(200);
        const rows = prompts.json<any>().prompts;
        if (rows.length !== 1 || rows[0].text !== "Read the image")
          throw new Error("first prompt did not persist exactly once");
        if (JSON.stringify(rows).includes("data:"))
          throw new Error("inline bytes leaked into the public inbox");
      },
    );
    const messageId = `msg_${Date.now().toString(16).padStart(12, "0")}${"A".repeat(14)}`;
    const prompt = {
      client_message_id: `image-${sessionId}`,
      message_id: messageId,
      parts: [{ type: "text", text: "Read it again" }, image],
    };
    await ctx.step(
      "a boot-time image prompt persists once and a retry returns the same command",
      async () => {
        const first = await owner.post(
          "/v1/projects/:projectId/sessions/:sessionId/prompts",
          prompt,
          { params },
        );
        first.status(202);
        const retry = await owner.post(
          "/v1/projects/:projectId/sessions/:sessionId/prompts",
          prompt,
          { params },
        );
        retry
          .status(200)
          .body()
          .has("$.prompt_id", first.json<any>().prompt_id)
          .has("$.deduped", true);
        if ((await readPrompts()).json<any>().prompts.length !== 2)
          throw new Error("retry duplicated the image prompt");
        if ((await readImage()).text() !== content)
          throw new Error("retry changed the image");
      },
    );
    await ctx.step(
      "an accepted Pi prompt retry reuses immutable content without fetching replacement URLs",
      async () => {
        const retry = await owner.post(
          "/v1/projects/:projectId/sessions/:sessionId/prompts",
          { ...prompt, parts: [{ ...image, url: "https://127.0.0.1/private.png" }] },
          { params },
        );
        retry.status(200).body().has("$.deduped", true);
        if ((await readPrompts()).json<any>().prompts.length !== 2)
          throw new Error("replacement URL duplicated the accepted prompt");
        if ((await readImage()).text() !== content)
          throw new Error("replacement URL changed the accepted bytes");
      },
    );
    await ctx.step(
      "new Pi prompts refuse private HTTPS targets without persisting a command",
      async () => {
        for (const url of ["https://127.0.0.1/private.png", "https://[::ffff:7f00:1]/private.png"]) {
          (await owner.post(
            "/v1/projects/:projectId/sessions/:sessionId/prompts",
            { ...prompt, client_message_id: crypto.randomUUID(), parts: [{ ...image, url }] },
            { params },
          )).status(400);
        }
        if ((await readPrompts()).json<any>().prompts.length !== 2)
          throw new Error("unsafe URL created a partial prompt");
      },
    );
    await ctx.step(
      "a conflicting image MIME rejects the new prompt and preserves both existing commands and bytes",
      async () => {
        const conflict = await owner.post(
          "/v1/projects/:projectId/sessions/:sessionId/prompts",
          {
            ...prompt,
            client_message_id: `conflict-${sessionId}`,
            parts: [
              {
                ...image,
                mime: "image/jpeg",
                url: image.url.replace("image/png", "image/jpeg"),
              },
            ],
          },
          { params },
        );
        conflict.status(409);
        if ((await readPrompts()).json<any>().prompts.length !== 2)
          throw new Error("conflict created a partial command");
        const response = await readImage();
        if (
          response.text() !== content ||
          response.header("content-type") !== "image/png"
        )
          throw new Error("conflict overwrote the image");
      },
    );
    await ctx.step(
      "anonymous and nonmember callers cannot read the staged image",
      async () => {
        (
          await ctx.client
            .as(ctx.P.ANON)
            .get(
              "/v1/projects/:projectId/sessions/:sessionId/attachments/:sha256",
              { params: { ...params, sha256 } },
            )
        ).status(401);
        (
          await ctx.client
            .as(ctx.P.NONMEMBER)
            .get(
              "/v1/projects/:projectId/sessions/:sessionId/attachments/:sha256",
              { params: { ...params, sha256 } },
            )
        ).status([403, 404]);
      },
    );
  },
);
