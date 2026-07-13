/**
 * 03 — does creating a session work? Pure platform REST (no sandbox yet):
 * create, then re-list the project's sessions and assert the new id is there.
 *
 * Run (from packages/sdk):  bun run playground/sessions/03-create-session.ts [projectId]
 */
import { makeKortix, pickProjectId, run } from "../_shared";

run("create-session", async () => {
  const kortix = makeKortix();
  const projectId = await pickProjectId(kortix, process.argv[2]);

  const created = await kortix.projects.createSession(projectId, {
    name: "sdk playground test",
  });
  console.log(
    `✓ createSession returned ${created.session_id} (status: ${created.status})`,
  );

  const sessions = await kortix.projects.sessions(projectId);
  if (!sessions.some((s) => s.session_id === created.session_id)) {
    console.error(
      "✗ created session is NOT in the projects.sessions() re-list",
    );
    process.exit(1);
  }
  console.log("✓ re-listed the project — the new session is there");

  console.log("\npin it for the chat scripts:");
  console.log(`  export KORTIX_PROJECT_ID=${projectId}`);
  console.log(`  export KORTIX_SESSION_ID=${created.session_id}`);
});
