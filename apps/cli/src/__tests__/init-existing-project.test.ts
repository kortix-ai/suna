import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const cli = resolve(import.meta.dir, "..", "index.ts");

function seedGitRepo(repo: string): void {
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
}

describe("init in an existing cloned project", () => {
  test("--force wires the current Kortix repo in place without creating a child project", () => {
    const repo = mkdtempSync(resolve(tmpdir(), "kortix-init-existing-"));
    mkdirSync(resolve(repo, ".opencode"), { recursive: true });
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
    // `.opencode` is the real, checked-in config dir — no self-link.
    expect(lstatSync(resolve(repo, ".opencode")).isSymbolicLink()).toBe(false);
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
    // `.opencode` is the real, committed config tree on a migrated repo —
    // excluding it from git would hide new files under it from `git status`.
    expect(
      readFileSync(resolve(repo, ".git", "info", "exclude"), "utf8"),
    ).not.toContain("/.opencode");
  });

  test("--force on a fresh legacy clone (.kortix/opencode real, no .opencode entry at all) is accepted and creates the compat symlink", () => {
    const repo = mkdtempSync(resolve(tmpdir(), "kortix-init-legacy-"));
    // A fresh clone of an un-migrated pre-1.x repo: the real scaffold content
    // is committed at `.kortix/opencode`. The old `.opencode` symlink was
    // local-only wiring (`.git/info/exclude`), never committed, so a fresh
    // clone has NO `.opencode` entry at all.
    mkdirSync(resolve(repo, ".kortix/opencode/skills/kortix-system"), {
      recursive: true,
    });
    writeFileSync(
      resolve(repo, ".kortix/opencode/skills/kortix-system/SKILL.md"),
      "canonical skill\n",
    );
    writeFileSync(
      resolve(repo, "kortix.yaml"),
      "kortix_version: 2\nproject:\n  name: Legacy\n",
    );
    seedGitRepo(repo);
    expect(existsSync(resolve(repo, ".opencode"))).toBe(false);

    const result = spawnSync("bun", [cli, "init", "--force"], {
      cwd: repo,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    // The gate accepted the legacy layout, and the downstream reconciliation
    // created the `.opencode -> .kortix/opencode` compat link so `.claude`/
    // `.agents` don't dangle.
    expect(lstatSync(resolve(repo, ".opencode")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(resolve(repo, ".opencode"))).toBe(".kortix/opencode");
    expect(lstatSync(resolve(repo, ".claude")).isSymbolicLink()).toBe(true);
    expect(lstatSync(resolve(repo, ".agents")).isSymbolicLink()).toBe(true);
    expect(
      readFileSync(resolve(repo, ".claude/skills/kortix-system/SKILL.md"), "utf8"),
    ).toBe("canonical skill\n");
    expect(
      readFileSync(resolve(repo, ".agents/skills/kortix-system/SKILL.md"), "utf8"),
    ).toBe("canonical skill\n");
    // `.opencode` is local compat wiring here (a legacy clone), so it must be
    // excluded from git same as the other local wiring entries.
    expect(
      readFileSync(resolve(repo, ".git", "info", "exclude"), "utf8"),
    ).toContain("/.opencode");
  });
});
