import { describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const cli = resolve(import.meta.dir, "..", "index.ts");

describe("init in an existing cloned project", () => {
  test("--force wires the current Kortix repo in place without creating a child project", () => {
    const repo = mkdtempSync(resolve(tmpdir(), "kortix-init-existing-"));
    mkdirSync(resolve(repo, ".kortix", "opencode"), { recursive: true });
    writeFileSync(
      resolve(repo, "kortix.yaml"),
      "kortix_version: 2\nproject:\n  name: Existing\n",
    );
    writeFileSync(resolve(repo, "README.md"), "keep me\n");
    spawnSync("git", ["init", "-b", "main"], { cwd: repo });
    spawnSync("git", ["add", "."], { cwd: repo });
    spawnSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "seed",
      ],
      { cwd: repo },
    );

    const result = spawnSync("bun", [cli, "init", "--force"], {
      cwd: repo,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `Configured this Kortix project in ${realpathSync(repo)}`,
    );
    expect(lstatSync(resolve(repo, ".agents")).isSymbolicLink()).toBe(true);
    expect(lstatSync(resolve(repo, ".opencode")).isSymbolicLink()).toBe(true);
    expect(lstatSync(resolve(repo, ".claude")).isSymbolicLink()).toBe(true);
    expect(readFileSync(resolve(repo, "AGENTS.md"), "utf8")).toContain(
      "This repository is a",
    );
    expect(readFileSync(resolve(repo, "README.md"), "utf8")).toBe("keep me\n");
    expect(() => lstatSync(resolve(repo, "kortix-project"))).toThrow();
    expect(
      spawnSync("git", ["status", "--porcelain"], {
        cwd: repo,
        encoding: "utf8",
      }).stdout,
    ).toBe("");
  });
});
