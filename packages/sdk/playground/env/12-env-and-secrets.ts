/**
 * 12 — environment variables: manifest-declared env + a full secrets CRUD
 * round-trip. Secrets are project-scoped env vars every session's agent can
 * read at runtime. Pure platform REST — no sandbox.
 *
 * Run (from packages/sdk):  bun run playground/env/12-env-and-secrets.ts [projectId]
 */
import { makeKortix, pickProjectId, run } from "../_shared";

const TEST_SECRET = "SDK_PLAYGROUND_TEST_SECRET";

run("env-and-secrets", async () => {
  const kortix = makeKortix();
  const projectId = await pickProjectId(kortix, process.argv[2]);
  const project = kortix.project(projectId);

  const detail = await kortix.projects.detail(projectId);
  console.log("✓ manifest-declared env:");
  console.log(`    required: ${detail.config.env.required.join(", ") || "—"}`);
  console.log(
    `    optional: ${detail.config.env.optional.join(", ") || "—"}\n`,
  );

  const before = await project.secrets.list();
  console.log(
    `✓ ${before.items.length} secret(s): ${before.items.map((s) => s.name).join(", ") || "—"}`,
  );

  await project.secrets.upsert({
    name: TEST_SECRET,
    value: "from-the-sdk-playground",
  });
  console.log(`✓ upserted ${TEST_SECRET}`);

  const during = await project.secrets.list();
  if (!during.items.some((s) => s.name === TEST_SECRET)) {
    console.error("✗ upserted secret is NOT in the re-list");
    process.exit(1);
  }
  console.log(
    "✓ re-listed — it is there (value is write-only, never returned)",
  );

  await project.secrets.remove(TEST_SECRET);
  const after = await project.secrets.list();
  if (after.items.some((s) => s.name === TEST_SECRET)) {
    console.error("✗ secret still listed after remove()");
    process.exit(1);
  }
  console.log("✓ removed — list is back to where it started");
});
