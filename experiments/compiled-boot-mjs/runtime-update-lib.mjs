import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileBundle } from "./lib.mjs";
import { RuntimeSupervisor } from "./runtime-supervisor.mjs";

const FIXTURE_DIR = fileURLToPath(new URL("./fixture/", import.meta.url));

export async function compileVariant(rootDir, name, configFile) {
  const sourceDir = join(rootDir, `${name}-source`);
  const artifactPath = join(rootDir, "artifacts", name, "server.mjs");
  await mkdir(sourceDir, { recursive: true });
  await Promise.all([
    copyFile(join(FIXTURE_DIR, "server.ts"), join(sourceDir, "server.ts")),
    copyFile(
      join(FIXTURE_DIR, configFile),
      join(sourceDir, "kortix.config.ts"),
    ),
  ]);
  await compileBundle(join(sourceDir, "server.ts"), artifactPath);
  return artifactPath;
}

async function readConfig(url) {
  const response = await fetch(`${url}/config`);
  if (!response.ok) {
    throw new Error(`config request failed: ${response.status}`);
  }
  return response.json();
}

export async function runRuntimeUpdateDemo() {
  const rootDir = await mkdtemp(join(tmpdir(), "mjs-runtime-update-"));
  const supervisor = new RuntimeSupervisor({ verifyTimeoutMs: 250 });

  try {
    const initialArtifact = await compileVariant(
      rootDir,
      "v1",
      "kortix.config.ts",
    );
    await supervisor.start(initialArtifact, { expectedVersion: "v1" });
    const before = await readConfig(supervisor.url);

    let releaseBuild;
    let reportBuildStarted;
    const buildStarted = new Promise((resolve) => {
      reportBuildStarted = resolve;
    });
    const buildRelease = new Promise((resolve) => {
      releaseBuild = resolve;
    });
    const updatePromise = supervisor.update(
      async () => {
        reportBuildStarted();
        await buildRelease;
        return compileVariant(rootDir, "v2", "kortix.config.v2.ts");
      },
      { expectedVersion: "v2" },
    );

    await buildStarted;
    const duringBuild = await readConfig(supervisor.url);
    releaseBuild();
    const update = await updatePromise;
    const afterPromotion = await readConfig(supervisor.url);

    const failedUpdate = await supervisor.update(
      () => compileVariant(rootDir, "broken", "kortix.config.unhealthy.ts"),
      { expectedVersion: "broken" },
    );
    const afterFailure = await readConfig(supervisor.url);

    return {
      beforeVersion: before.runtime.version,
      duringBuildVersion: duringBuild.runtime.version,
      promoted: update.promoted,
      afterPromotionVersion: afterPromotion.runtime.version,
      failedCandidatePromoted: failedUpdate.promoted,
      failedCandidateStage: failedUpdate.stage,
      afterFailureVersion: afterFailure.runtime.version,
    };
  } finally {
    await supervisor.close();
    await rm(rootDir, { recursive: true, force: true });
  }
}
