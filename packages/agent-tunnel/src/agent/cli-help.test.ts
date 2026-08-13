import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const CLI_PATH = resolve(import.meta.dir, "cli.ts");

/**
 * The published CLI's help text is its documented surface. tests/bin/package-quality.ts
 * asserts the same list against the packed tarball; duplicating it here makes an
 * accidental removal fail in this package's own suite instead of only in CI.
 */
const DOCUMENTED_SURFACE = [
  "connect",
  "run",
  "install-service",
  "service-status",
  "uninstall-service",
  "status",
  "logs",
  "logout",
  "--daemon",
  "--foreground",
] as const;

describe("agent tunnel documented CLI surface", () => {
  for (const entry of DOCUMENTED_SURFACE) {
    test(`help lists ${entry}`, () => {
      const result = spawnSync("bun", ["run", CLI_PATH, "help"], {
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(entry);
    });
  }

  // Only read-only commands are executed here. start/stop/restart/logout/unpair
  // mutate the real launchd domain and credential file — running them from a
  // test suite would stop a developer's live service or delete their pairing.
  for (const command of ["status", "service-status"] as const) {
    test(`${command} routes to the status view`, () => {
      const home = mkdtempSync(join(tmpdir(), "agent-tunnel-help-"));
      try {
        const result = spawnSync("bun", ["run", CLI_PATH, command, "--json"], {
          encoding: "utf8",
          env: { ...process.env, HOME: home },
        });
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({ paired: false });
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }

  test("an unknown command falls back to help", () => {
    const result = spawnSync("bun", ["run", CLI_PATH, "not-a-command"], {
      encoding: "utf8",
    });
    expect(result.stdout).toContain("Secure bridge between AI agents");
  });
});

describe("agent tunnel service UX", () => {
  test("offers persistent daemon mode without an unsupported keep-awake flag", () => {
    const result = spawnSync("bun", ["run", CLI_PATH, "help"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--daemon");
    expect(result.stdout).toContain("--foreground");
    expect(result.stdout).not.toContain("--keep-awake");
  });

  test("rejects the removed keep-awake flag instead of silently ignoring it", () => {
    const result = spawnSync(
      "bun",
      ["run", CLI_PATH, "connect", "--keep-awake"],
      {
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--keep-awake is not supported");
  });
});
