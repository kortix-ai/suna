import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCloneAndCompile, runPrecompiled } from "./lib.mjs";

const cacheDir = await mkdtemp(join(tmpdir(), "compiled-boot-demo-test-"));
const options = { cacheDir, files: 4, fileKb: 1, json: true, rebuild: false };

afterAll(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

describe("standalone compiled boot demo", () => {
  test("clone path clones, compiles, starts, and verifies the server", async () => {
    const result = await runCloneAndCompile(options);

    expect(result.path).toBe("clone-compile-start");
    expect(result.cloneMs).toBeGreaterThan(0);
    expect(result.compileMs).toBeGreaterThan(0);
    expect(result.bundleBytes).toBeGreaterThan(0);
    expect(result.health).toEqual({
      status: "ok",
      agent: "compiled-boot-demo",
      version: "v1",
    });
  });

  test("compiled path starts from one server.mjs without source files", async () => {
    const result = await runPrecompiled(options);

    expect(result.path).toBe("precompiled-mjs-start");
    expect(result.sourcePresentAtBoot).toBe(false);
    expect(result.artifactBytes).toBeGreaterThan(0);
    expect(await readFile(result.artifactPath, "utf8")).toContain(
      "compiled-boot-demo",
    );
    expect(result.health).toEqual({
      status: "ok",
      agent: "compiled-boot-demo",
      version: "v1",
    });
  });

  test("compiled artifact is content-addressed and reused", async () => {
    const first = await runPrecompiled(options);
    const second = await runPrecompiled(options);

    expect(second.artifactPath).toBe(first.artifactPath);
    expect(second.artifactCacheHit).toBe(true);
  });
});
