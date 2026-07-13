/**
 * 23 — sandbox infrastructure: health, boot templates, live sandbox list,
 * and snapshot builds. All reads (rebuildSnapshot is deliberately skipped).
 *
 * Run (from packages/sdk):  bun run playground/sandbox/23-sandbox.ts [projectId]
 */
import { makeKortix, pickProjectId, run } from "../_shared";

run("sandbox", async () => {
  const kortix = makeKortix();
  const projectId = await pickProjectId(kortix, process.argv[2]);
  const project = kortix.project(projectId);

  const health = await kortix.projects.sandboxHealth(projectId);
  console.log(`✓ sandboxHealth(): ${JSON.stringify(health).slice(0, 250)}…`);

  const templates = await kortix.projects.sandboxTemplates(projectId);
  console.log(
    `✓ sandboxTemplates(): ${JSON.stringify(templates).slice(0, 250)}…`,
  );

  const sandboxes = await project.sandbox.list();
  console.log(`✓ sandbox.list(): ${JSON.stringify(sandboxes).slice(0, 250)}…`);

  const snapshots = await project.sandbox.snapshots();
  console.log(
    `✓ sandbox.snapshots(): ${JSON.stringify(snapshots).slice(0, 250)}…`,
  );
});
