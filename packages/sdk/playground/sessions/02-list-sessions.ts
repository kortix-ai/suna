/**
 * 02 — given a project, can I read its sessions?
 * Project selection: argv[2] → KORTIX_PROJECT_ID → first project.
 *
 * Run (from packages/sdk):  bun run playground/sessions/02-list-sessions.ts [workspaceId]
 */
import { makeKortix, pickProjectId, run } from "../_shared";

run("list-sessions", async () => {
  const kortix = makeKortix();
  const workspaceId = await pickProjectId(kortix, process.argv[2]);

  const sessions = await kortix.projects.sessions(workspaceId);

  console.log(
    `✓ projects.sessions(${workspaceId}) returned ${sessions.length} session(s):\n`,
  );
  for (const s of sessions) {
    console.log(`  ${s.name ?? s.branch_name}`);
    console.log(`    id:     ${s.session_id}`);
    console.log(`    status: ${s.status}`);
    console.log(`    agent:  ${s.agent_name ?? "—"}\n`);
  }

  if (sessions.length > 0) {
    console.log("pin one for the chat scripts:");
    console.log(`  export KORTIX_SESSION_ID=${sessions[0]!.session_id}`);
  }
});
