import { and, eq } from "drizzle-orm";
import { projectSessions } from "@kortix/db";
import { PROJECT_ACTIONS } from "../../iam";
import { db } from "../../shared/db";
import { assertProjectCapability, loadProjectForUser } from "./access";
import { projectsApp } from "./app";
import { callerKortixSessionId } from "./caller-session";
import { UUID_V4_REGEX } from "./serializers";

export async function authorizeSessionStorageCall(
  c: Parameters<Parameters<typeof projectsApp.openapi>[1]>[0],
  action: (typeof PROJECT_ACTIONS)[keyof typeof PROJECT_ACTIONS],
): Promise<
  { kind: "error"; response: Response } | { kind: "ok"; sessionId: string }
> {
  const projectId = c.req.param("projectId") ?? "";
  const sessionId = c.req.param("sessionId") ?? "";
  if (!UUID_V4_REGEX.test(sessionId)) {
    return {
      kind: "error",
      response: c.json({ error: "Invalid session id" }, 400),
    };
  }
  const loaded = await loadProjectForUser(c, projectId, "read");
  if (!loaded)
    return { kind: "error", response: c.json({ error: "Not found" }, 404) };
  const callerSession = callerKortixSessionId(c);
  if (callerSession && callerSession !== sessionId) {
    return { kind: "error", response: c.json({ error: "Forbidden" }, 403) };
  }
  if (!callerSession) {
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      action,
    );
  }
  // Scoped to the project AND account the caller was just authorized for.
  // Authorization above proves the caller may act on `projectId`; without
  // these two predicates the ROW is fetched by session id alone, so a caller
  // authorized on their own project could pass any other project's session id
  // and act on it — authorization checked against one object, action taken on
  // another. Mirrors `loadProjectSessionRow` (projects/lib/access.ts).
  const [session] = await db
    .select({ metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(
      and(
        eq(projectSessions.sessionId, sessionId),
        eq(projectSessions.projectId, loaded.row.projectId),
        eq(projectSessions.accountId, loaded.row.accountId),
      ),
    )
    .limit(1);
  if (
    !session ||
    (session.metadata as Record<string, unknown> | null)?.deletedAt
  ) {
    return { kind: "error", response: c.json({ error: "Not found" }, 404) };
  }
  return { kind: "ok", sessionId };
}
