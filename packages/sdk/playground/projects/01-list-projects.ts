/**
 * 01 — do ALL my projects come back from `projects.list()`?
 * Compare the output against the web UI at localhost:3000.
 *
 * Run (from packages/sdk):  bun run playground/projects/01-list-projects.ts
 */
import { makeKortix, run } from "../_shared";

run("list-projects", async () => {
  const kortix = makeKortix();
  const projects = await kortix.projects.list();

  console.log(`✓ projects.list() returned ${projects.length} project(s):\n`);
  for (const p of projects) {
    console.log(`  ${p.name}`);
    console.log(`    id:   ${p.project_id}`);
    console.log(`    repo: ${p.repo_url ?? "—"}\n`);
  }

  if (projects.length > 0) {
    console.log("pin one for the other scripts:");
    console.log(`  export KORTIX_PROJECT_ID=${projects[0]!.project_id}`);
  }
});
