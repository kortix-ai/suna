import { createRoute, z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { MAX_SESSION_ATTACHMENT_BYTES } from "@kortix/shared";
import { auth, errors, json } from "../../openapi";
import { requireFeatureFlag } from "../../feature-flags/gate";
import { PROJECT_ACTIONS } from "../../iam";
import { assertAgentScope } from "../../iam/agent-scope";
import { projectsApp } from "../lib/app";
import {
  assertProjectCapability,
  loadProjectForUser,
  loadVisibleSession,
  sessionIsTombstoned,
} from "../lib/access";
import { callerKortixSessionId } from "../lib/caller-session";
import { sessionAttachmentStore } from "../lib/session-attachments";
import { UUID_V4_REGEX } from "../lib/serializers";

const path = "/{projectId}/sessions/{sessionId}/attachments";
const params = z.object({
  projectId: z.string().uuid(),
  sessionId: z.string().uuid(),
});
const attachmentSchema = z.object({
  attachment_id: z.string(),
  filename: z.string(),
  mime: z.string(),
  size: z.number(),
  url: z.string(),
});

projectsApp.use(
  "/:projectId/sessions/:sessionId/attachments",
  bodyLimit({
    maxSize: MAX_SESSION_ATTACHMENT_BYTES + 64 * 1024,
    onError: (c) =>
      c.json({ error: "Attachments must be 50 MiB or smaller." }, 413),
  }),
);

projectsApp.openapi(
  createRoute({
    method: "post",
    path,
    tags: ["sessions"],
    summary: "Save a private session attachment before sandbox startup",
    ...auth,
    request: {
      params,
      body: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: z.object({
              attachment_id: z.string().uuid(),
              file: z.any().openapi({ type: "string", format: "binary" }),
            }),
          },
        },
      },
    },
    responses: {
      201: json(attachmentSchema, "Saved attachment"),
      ...errors(400, 403, 404, 409, 413, 503),
    },
  }),
  async (c) => {
    const { projectId, sessionId } = c.req.valid("param");
    const loaded = await loadProjectForUser(c, projectId, "session");
    if (!loaded) return c.json({ error: "Not found" }, 404);
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_START);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SESSION_START,
    );
    const visible = await loadVisibleSession(
      loaded,
      sessionId,
      callerKortixSessionId(c),
      callerKortixSessionId(c),
    );
    if (!visible || sessionIsTombstoned(visible.row))
      return c.json({ error: "Not found" }, 404);
    const gate = requireFeatureFlag(
      c,
      loaded.row.metadata,
      "session_transcript_history",
    );
    if (gate) return gate as any;
    const body = await c.req.formData();
    const file = body.get("file");
    const attachmentId = body.get("attachment_id");
    if (
      !(file instanceof File) ||
      typeof attachmentId !== "string" ||
      !UUID_V4_REGEX.test(attachmentId)
    ) {
      return c.json(
        { error: "A file and attachment_id UUID are required" },
        400,
      );
    }
    if (file.size > MAX_SESSION_ATTACHMENT_BYTES)
      return c.json({ error: "Attachments must be 50 MiB or smaller." }, 413);
    const filename = file.name.trim() || "File";
    const mime = (file.type || "application/octet-stream")
      .split(";")[0]!
      .trim()
      .toLowerCase();
    if (filename.length > 1024 || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime)) {
      return c.json({ error: "Invalid attachment filename or MIME type" }, 400);
    }
    const scope = { projectId, sessionId, attachmentId };
    try {
      const saved = await sessionAttachmentStore().put({
        ...scope,
        filename,
        mime,
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
      const current = await loadVisibleSession(
        loaded,
        sessionId,
        callerKortixSessionId(c),
        callerKortixSessionId(c),
      );
      if (!current || sessionIsTombstoned(current.row)) {
        await sessionAttachmentStore().remove(scope);
        return c.json({ error: "Session was deleted during upload" }, 404);
      }
      return c.json(saved, 201);
    } catch (error) {
      if (error instanceof Error && error.message.includes("different file"))
        return c.json({ error: error.message }, 409);
      console.error("[session-attachments] upload failed", {
        sessionId,
        attachmentId,
        error,
      });
      return c.json({ error: "Could not save attachment. Please retry." }, 503);
    }
  },
);

projectsApp.openapi(
  createRoute({
    method: "get",
    path: `${path}/{attachmentId}`,
    tags: ["sessions"],
    summary: "Read private attachment bytes without starting the sandbox",
    ...auth,
    request: { params: params.extend({ attachmentId: z.string().uuid() }) },
    responses: {
      200: {
        description: "Attachment bytes",
        content: {
          "application/octet-stream": {
            schema: z.string().openapi({ format: "binary" }),
          },
        },
      },
      ...errors(400, 403, 404, 503),
    },
  }),
  async (c) => {
    const { projectId, sessionId, attachmentId } = c.req.valid("param");
    const loaded = await loadProjectForUser(c, projectId, "read");
    if (!loaded) return c.json({ error: "Not found" }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SESSION_READ,
    );
    const visible = await loadVisibleSession(
      loaded,
      sessionId,
      callerKortixSessionId(c),
      callerKortixSessionId(c),
    );
    if (!visible || sessionIsTombstoned(visible.row))
      return c.json({ error: "Not found" }, 404);
    try {
      const blob = await sessionAttachmentStore().read({
        projectId,
        sessionId,
        attachmentId,
      });
      if (!blob) return c.json({ error: "Attachment not found" }, 404);
      return c.body(await blob.arrayBuffer(), 200, {
        "Content-Type": blob.type || "application/octet-stream",
        "Content-Disposition": "attachment",
        "Content-Length": String(blob.size),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      });
    } catch (error) {
      console.error("[session-attachments] read failed", {
        sessionId,
        attachmentId,
        error,
      });
      return c.json({ error: "Could not load attachment. Please retry." }, 503);
    }
  },
);
