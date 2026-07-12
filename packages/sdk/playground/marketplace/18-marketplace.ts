/**
 * 18 — marketplace: public catalog browse (top-level) + this project's
 * installed registry items and available updates. All reads — install/remove
 * commit onto the project branch, so they are not exercised here.
 *
 * Run (from packages/sdk):  bun run playground/marketplace/18-marketplace.ts [projectId]
 */
import { makeKortix, pickProjectId, run } from "../_shared";

run("marketplace", async () => {
  const kortix = makeKortix();
  const projectId = await pickProjectId(kortix, process.argv[2]);

  const items = await kortix.marketplace.items();
  console.log(`✓ marketplace.items(): ${JSON.stringify(items).slice(0, 250)}…`);

  const marketplaces = await kortix.marketplace.marketplaces();
  console.log(
    `✓ marketplaces(): ${JSON.stringify(marketplaces).slice(0, 200)}…`,
  );

  const sources = await kortix.marketplace.sources.list();
  console.log(`✓ sources.list(): ${JSON.stringify(sources).slice(0, 200)}`);

  const registry = kortix.project(projectId).registry;
  const installed = await registry.list();
  console.log(
    `✓ project registry.list(): ${JSON.stringify(installed).slice(0, 250)}…`,
  );

  const updates = await registry.updates();
  console.log(`✓ registry.updates(): ${JSON.stringify(updates).slice(0, 200)}`);
});
