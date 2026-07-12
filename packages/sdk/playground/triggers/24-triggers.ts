/**
 * 24 — triggers (cron / event automations): list what the project has.
 * Read-only — create/fire/remove mutate project automation, run those
 * deliberately.
 *
 * Run (from packages/sdk):  bun run playground/triggers/24-triggers.ts [projectId]
 */
import { makeKortix, pickProjectId, run } from "../_shared";

run("triggers", async () => {
  const kortix = makeKortix();
  const projectId = await pickProjectId(kortix, process.argv[2]);

  const triggers = await kortix.project(projectId).triggers.list();
  console.log(`✓ triggers.list(): ${JSON.stringify(triggers).slice(0, 400)}…`);
});
