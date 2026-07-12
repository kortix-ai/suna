/**
 * 30 — the full session lifecycle: create with a CLIENT-generated id
 * (`generateSessionId`), read it back, rename it via `update()`, `stop()` it,
 * `delete()` it, and verify it is gone. Cleans up completely — this script
 * REDUCES session clutter rather than adding to it.
 *
 * Run (from packages/sdk):  bun run playground/sessions/30-session-crud.ts [projectId]
 */
import { ApiError, generateSessionId } from "../../src/index";
import { makeKortix, pickProjectId, run } from "../_shared";

run("session-crud", async () => {
  const kortix = makeKortix();
  const projectId = await pickProjectId(kortix, process.argv[2]);

  const clientId = generateSessionId();
  const created = await kortix.projects.createSession(projectId, {
    name: "sdk crud test",
    session_id: clientId,
  });
  if (created.session_id !== clientId) {
    console.error(
      `✗ server ignored the client-generated id (got ${created.session_id})`,
    );
    process.exit(1);
  }
  console.log(
    `✓ created with client-generated id ${clientId} — server honored it`,
  );

  const session = kortix.session(projectId, clientId);

  const row = await session.get();
  console.log(`✓ get(): status=${(row as { status?: string } | null)?.status}`);

  await session.update({ name: "sdk crud test (renamed)" });
  const renamed = await session.get();
  const name = (renamed as { name?: string | null } | null)?.name;
  if (name !== "sdk crud test (renamed)") {
    console.error(
      `✗ update() rename did not stick (name is ${JSON.stringify(name)})`,
    );
    process.exit(1);
  }
  console.log("✓ update() renamed it — re-read confirms");

  try {
    await session.stop();
    console.log("✓ stop() accepted");
  } catch (error) {
    const status =
      error instanceof ApiError
        ? (error.status ?? Number(error.code))
        : undefined;
    if (status === 404) {
      console.log(
        "✓ stop(): 404 — nothing running to stop (sandbox never started for this session), acceptable",
      );
    } else {
      throw error;
    }
  }

  await session.delete();
  const sessions = await kortix.projects.sessions(projectId);
  if (sessions.some((s) => s.session_id === clientId)) {
    console.error("✗ session still listed after delete()");
    process.exit(1);
  }
  console.log("✓ delete() — gone from the re-list, nothing left behind");
});
