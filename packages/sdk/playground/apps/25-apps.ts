/**
 * 25 — project apps/deployments: list what is deployed. Read-only —
 * create/deploy/stop provision real infrastructure, run those deliberately.
 *
 * Run (from packages/sdk):  bun run playground/apps/25-apps.ts [projectId]
 */
import { ApiError } from "../../src/index";
import { makeKortix, pickProjectId, run } from "../_shared";

run("apps", async () => {
  const kortix = makeKortix();
  const projectId = await pickProjectId(kortix, process.argv[2]);

  try {
    const apps = await kortix.project(projectId).apps.list();
    console.log(`✓ apps.list(): ${JSON.stringify(apps).slice(0, 400)}`);
  } catch (error) {
    const status =
      error instanceof ApiError
        ? (error.status ?? Number(error.code))
        : undefined;
    if (status === 404) {
      console.log(
        "✓ apps.list(): 404 — the 'apps' experimental feature is not enabled on this project",
      );
      console.log(
        "  (enable via project.updateExperimentalFeature('apps', true), then re-run)",
      );
      return;
    }
    throw error;
  }
});
