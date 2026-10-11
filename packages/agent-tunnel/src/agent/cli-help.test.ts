import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
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
  "access",
  "keep-awake",
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
    expect(result.stderr).toContain("--keep-awake is not a flag. Run: agent-tunnel keep-awake on");
  });
});

describe("access and keep-awake: the one way to change them on this computer", () => {
  const run = (home: string, ...args: string[]) =>
    spawnSync("bun", ["run", CLI_PATH, ...args], {
      encoding: "utf8",
      env: { ...process.env, AGENT_TUNNEL_HOME: home },
    });

  test("changes access and keep awake, prints the state, and writes access.json", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-tunnel-cli-access-"));
    try {
      const shown = JSON.parse(run(home, "access", "--json").stdout);
      expect(shown).toMatchObject({ mode: "always", keepAwake: false, pendingRequest: null });

      const ask = run(home, "access", "ask", "--json");
      expect(ask.status).toBe(0);
      expect(JSON.parse(ask.stdout).mode).toBe("ask");

      const granted = JSON.parse(run(home, "access", "--allow-for", "60", "--json").stdout);
      expect(Date.parse(granted.grantedUntil) - Date.now()).toBeGreaterThan(59 * 60_000);

      expect(JSON.parse(run(home, "access", "--revoke", "--json").stdout).grantedUntil).toBeNull();
      expect(JSON.parse(run(home, "keep-awake", "on", "--json").stdout).keepAwake).toBe(true);
      expect(JSON.parse(readFileSync(join(home, "access.json"), "utf8"))).toMatchObject({ mode: "ask", keepAwake: true });

      const status = JSON.parse(run(home, "status", "--json").stdout);
      expect(status.access).toMatchObject({ mode: "ask", keepAwake: true, keepAwakeSupported: process.platform !== "win32" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses a wrong mode or duration with exit 1 and changes nothing", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-tunnel-cli-access-"));
    try {
      const mode = run(home, "access", "sometimes");
      expect(mode.status).toBe(1);
      expect(mode.stderr).toContain("Access is one of: ask, always, off");
      const minutes = run(home, "access", "--allow-for", "soon");
      expect(minutes.status).toBe(1);
      expect(minutes.stderr).toContain("--allow-for takes minutes");
      const awake = run(home, "keep-awake", "maybe");
      expect(awake.status).toBe(1);
      expect(existsSync(join(home, "access.json"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
