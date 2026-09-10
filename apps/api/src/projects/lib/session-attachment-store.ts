import { sessionAttachments } from "@kortix/db";
import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { db } from "../../shared/db";
import type { StagedSessionAttachment } from "../session-lifecycle/pi-prompt-attachments";

export async function storeSessionAttachments(
  executor: Pick<typeof db, "insert" | "select">,
  sessionId: string,
  attachments: StagedSessionAttachment[],
): Promise<void> {
  for (const attachment of attachments) {
    const inserted = await executor
      .insert(sessionAttachments)
      .values({ sessionId, ...attachment })
      .onConflictDoNothing({
        target: [sessionAttachments.sessionId, sessionAttachments.sha256],
      })
      .returning({ sha256: sessionAttachments.sha256 });
    if (inserted.length) continue;
    const [existing] = await executor
      .select({
        contentType: sessionAttachments.contentType,
        content: sessionAttachments.content,
      })
      .from(sessionAttachments)
      .where(
        and(
          eq(sessionAttachments.sessionId, sessionId),
          eq(sessionAttachments.sha256, attachment.sha256),
        ),
      )
      .limit(1);
    if (
      !existing ||
      existing.contentType !== attachment.contentType ||
      !Buffer.from(existing.content).equals(attachment.content)
    ) {
      throw new HTTPException(409, {
        message: "attachment bytes and MIME type are immutable",
      });
    }
  }
}
