import { createRoute, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { sessionAttachments } from "@kortix/db";
import { PROJECT_ACTIONS } from "../../iam";
import { auth, errors } from "../../openapi";
import { db } from "../../shared/db";
import { projectsApp } from "../lib/app";
import { authorizeSessionStorageCall } from "../lib/session-storage-access";
import { storeSessionAttachments } from "../lib/session-attachment-store";
import {
  readSessionAttachment,
  validateAttachmentIdentity,
  SESSION_ATTACHMENT_SHA256,
} from "../lib/session-attachment-input";

const params = z.object({
  projectId: z.string(),
  sessionId: z.string(),
  sha256: z.string().regex(SESSION_ATTACHMENT_SHA256),
});
const path = "/{projectId}/sessions/{sessionId}/attachments/{sha256}";

projectsApp.openapi(
  createRoute({
    method: "put",
    path,
    tags: ["projects"],
    ...auth,
    summary: "Store immutable attachment bytes without starting a runtime",
    request: {
      params,
      body: {
        content: {
          "application/octet-stream": {
            schema: z.string().openapi({ format: "binary" }),
          },
        },
      },
    },
    responses: {
      204: {
        description:
          "Stored or already present with the same bytes and MIME type",
      },
      ...errors(400, 401, 403, 404, 409, 413),
    },
  }),
  async (c: any) => {
    const gate = await authorizeSessionStorageCall(
      c,
      PROJECT_ACTIONS.PROJECT_SESSION_START,
    );
    if (gate.kind === "error") return gate.response;
    const content = await readSessionAttachment(c.req.raw);
    const { sha256, contentType } = validateAttachmentIdentity(
      c.req.param("sha256"),
      c.req.header("content-type") ?? "",
      content,
    );
    await storeSessionAttachments(db, gate.sessionId, [{ sha256, contentType, content }]);
    return c.body(null, 204);
  },
);

projectsApp.openapi(
  createRoute({
    method: "get",
    path,
    tags: ["projects"],
    ...auth,
    summary:
      "Read immutable attachment bytes from a stopped or running session",
    request: { params },
    responses: {
      200: {
        description: "Exact attachment bytes",
        content: {
          "application/octet-stream": {
            schema: z.string().openapi({ format: "binary" }),
          },
        },
      },
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c: any) => {
    const gate = await authorizeSessionStorageCall(
      c,
      PROJECT_ACTIONS.PROJECT_SESSION_READ,
    );
    if (gate.kind === "error") return gate.response;
    const sha256 = c.req.param("sha256");
    const [row] = await db
      .select({
        contentType: sessionAttachments.contentType,
        content: sessionAttachments.content,
      })
      .from(sessionAttachments)
      .where(
        and(
          eq(sessionAttachments.sessionId, gate.sessionId),
          eq(sessionAttachments.sha256, sha256),
        ),
      )
      .limit(1);
    if (!row) return c.json({ error: "attachment not found" }, 404);
    return new Response(new Uint8Array(row.content), {
      headers: {
        "content-type": row.contentType,
        "content-length": String(row.content.length),
        "content-disposition": "attachment",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": "private, max-age=31536000, immutable",
        etag: `"${sha256}"`,
        vary: "Authorization, Cookie",
      },
    });
  },
);
