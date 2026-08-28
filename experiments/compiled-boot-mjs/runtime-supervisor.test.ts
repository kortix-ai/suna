import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileVariant } from "./runtime-update-lib.mjs";
import { RuntimeSupervisor } from "./runtime-supervisor.mjs";

const resources: Array<{
  rootDir: string;
  supervisor: RuntimeSupervisor;
}> = [];

async function createRuntime(env: Record<string, string> = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), "runtime-supervisor-test-"));
  const supervisor = new RuntimeSupervisor({
    drainTimeoutMs: 3000,
    verifyTimeoutMs: 250,
  });
  resources.push({ rootDir, supervisor });
  const initial = await compileVariant(rootDir, "v1", "kortix.config.ts");
  await supervisor.start(initial, { expectedVersion: "v1", env });
  return { rootDir, supervisor };
}

async function readVersion(url: string) {
  const response = await fetch(`${url}/config`);
  const config = await response.json();
  return config.runtime.version;
}

async function openStream(url: string) {
  return new Promise<{ firstChunk: string }>((resolve, reject) => {
    const request = get(`${url}/stream`, (response) => {
      response.once("data", (chunk) => {
        resolve({
          firstChunk: chunk.toString("utf8"),
        });
      });
      response.once("error", reject);
    });
    request.once("error", reject);
  });
}

afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async ({ rootDir, supervisor }) => {
      await supervisor.close();
      await rm(rootDir, { recursive: true, force: true });
    }),
  );
});

describe("MJS runtime supervisor", () => {
  test("keeps the active runtime serving while a candidate builds and then promotes it", async () => {
    const { rootDir, supervisor } = await createRuntime();
    let releaseBuild: () => void;
    let reportBuildStarted: () => void;
    const buildStarted = new Promise<void>((resolve) => {
      reportBuildStarted = resolve;
    });
    const buildRelease = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    const update = supervisor.update(
      async () => {
        reportBuildStarted();
        await buildRelease;
        return compileVariant(rootDir, "v2", "kortix.config.v2.ts");
      },
      { expectedVersion: "v2" },
    );

    await buildStarted;
    expect(await readVersion(supervisor.url)).toBe("v1");
    releaseBuild!();
    expect((await update).promoted).toBe(true);
    expect(await readVersion(supervisor.url)).toBe("v2");
  });

  test("keeps the previous runtime when candidate health verification fails", async () => {
    const { rootDir, supervisor } = await createRuntime();
    const previousArtifact = supervisor.snapshot().active?.artifactPath;

    const result = await supervisor.update(
      () => compileVariant(rootDir, "broken", "kortix.config.unhealthy.ts"),
      { expectedVersion: "broken" },
    );

    expect(result.promoted).toBe(false);
    expect(result.stage).toBe("verify");
    expect(supervisor.snapshot().active?.artifactPath).toBe(previousArtifact);
    expect((await stat(previousArtifact!)).isFile()).toBe(true);
    expect(await readVersion(supervisor.url)).toBe("v1");
  });

  test("keeps the previous runtime when the background build fails", async () => {
    const { supervisor } = await createRuntime();
    const previousArtifact = supervisor.snapshot().active?.artifactPath;

    const result = await supervisor.update(async () => {
      throw new Error("compiler failed");
    });

    expect(result).toEqual(
      expect.objectContaining({
        promoted: false,
        stage: "build",
        reason: "compiler failed",
      }),
    );
    expect(supervisor.snapshot().active?.artifactPath).toBe(previousArtifact);
    expect(await readVersion(supervisor.url)).toBe("v1");
  });

  test("routes new requests to the candidate before draining an old streaming request", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "runtime-drain-test-"));
    const releaseFile = join(rootDir, "release");
    const supervisor = new RuntimeSupervisor({
      drainTimeoutMs: 3000,
      verifyTimeoutMs: 250,
    });
    resources.push({ rootDir, supervisor });
    const initial = await compileVariant(rootDir, "v1", "kortix.config.ts");
    await supervisor.start(initial, {
      expectedVersion: "v1",
      env: { DEMO_STREAM_RELEASE_FILE: releaseFile },
    });
    const oldPid = supervisor.snapshot().active?.pid;
    const stream = await openStream(supervisor.url);
    expect(stream.firstChunk).toContain("v1");

    const update = supervisor.update(
      () => compileVariant(rootDir, "v2", "kortix.config.v2.ts"),
      { expectedVersion: "v2" },
    );

    while ((await readVersion(supervisor.url)) !== "v2") await Bun.sleep(5);
    expect(supervisor.snapshot().retiring).toEqual([
      expect.objectContaining({ pid: oldPid, inFlight: 1, stopped: false }),
    ]);
    await writeFile(releaseFile, "complete\n");
    const result = await update;

    expect(result.promoted).toBe(true);
    expect(result.drained).toBe(true);
    expect(result.retired).toEqual(
      expect.objectContaining({ pid: oldPid, stopped: true }),
    );
    expect(supervisor.snapshot().retiring).toEqual([]);
  });
});
