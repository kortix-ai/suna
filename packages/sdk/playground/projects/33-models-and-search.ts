/**
 * 33 — the remaining project-level reads: LLM catalog, resolved model
 * defaults, repo file search, per-file git history, a single commit read,
 * featured marketplaces + one catalog item detail, and the Pipedream easy-
 * connect app catalog.
 *
 * Run (from packages/sdk):  bun run playground/projects/33-models-and-search.ts [projectId]
 */
import { makeKortix, pickProjectId, run } from "../_shared";

run("models-and-search", async () => {
  const kortix = makeKortix();
  const projectId = await pickProjectId(kortix, process.argv[2]);
  const project = kortix.project(projectId);

  const catalog = await kortix.projects.llmCatalog(projectId);
  console.log(
    `✓ llmCatalog(): ${Object.keys(catalog.models).length} model(s): ${Object.keys(catalog.models).join(", ")}`,
  );

  const defaults = await project.modelDefaults.get();
  console.log(
    `✓ modelDefaults.get(): ${JSON.stringify(defaults).slice(0, 250)}`,
  );

  const search = await project.files.search("kortix", { limit: 5 });
  console.log(
    `✓ files.search('kortix'): ${JSON.stringify(search).slice(0, 200)}…`,
  );

  const history = await project.files
    .history("README.md", { limit: 3 })
    .catch(() => null);
  console.log(
    history
      ? `✓ files.history('README.md'): ${JSON.stringify(history).slice(0, 200)}…`
      : "  (no README.md history — skipped)",
  );

  const commits = await project.git.commits();
  const sha = (
    Array.isArray(commits) ? (commits[0] as { sha?: string }) : undefined
  )?.sha;
  if (sha) {
    const commit = await project.git.commit(sha);
    console.log(
      `✓ git.commit(${sha.slice(0, 8)}): ${JSON.stringify(commit).slice(0, 150)}…`,
    );
  }

  const featured = await kortix.marketplace.featured();
  console.log(
    `✓ marketplace.featured(): ${JSON.stringify(featured).slice(0, 200)}…`,
  );

  const items = await kortix.marketplace.items();
  const firstId = (
    Array.isArray(items) ? (items[0] as { id?: string }) : undefined
  )?.id;
  if (firstId) {
    const item = await kortix.marketplace.item(firstId);
    console.log(
      `✓ marketplace.item('${firstId}'): ${JSON.stringify(item).slice(0, 150)}…`,
    );
  }

  const status = await kortix.connectStatus();
  if ((status as { enabled?: boolean }).enabled) {
    const apps = await project.connectors.pipedream.listApps("github");
    console.log(
      `✓ pipedream.listApps('github'): ${JSON.stringify(apps).slice(0, 200)}…`,
    );
  } else {
    console.log(
      "  (easy-connect disabled on this deployment — pipedream catalog skipped)",
    );
  }
});
