import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exitOnceDecided } from "../src/core/exit-once-decided";

// Release gate run 34510198802, api shard 4 printed
// `results: 82/84 passed · 1 failed · 1 skipped · 0 todo` at 18:44:39, then sat
// idle for 40 minutes until the job's 60-minute cap killed it. `cancelled`
// replaced the real verdict, poisoned `needs.api.result`, and failed
// `full suite + quality gates` for the whole promote. The runner had set
// `process.exitCode` and returned, so it waited on an event loop that one
// leaked handle kept alive forever.

const MODULE = join(import.meta.dirname, "..", "src", "core", "exit-once-decided.ts");

/** Runs a real bun process, returns its exit code and how long it took. */
function runScript(
  body: string,
  env: Record<string, string>,
  killAfterMs = 30_000,
): { code: number; ms: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "ke2e-exit-"));
  const file = join(dir, "probe.ts");
  writeFileSync(file, body);
  const startedAt = Date.now();
  try {
    const output = execFileSync("bun", [file], {
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: killAfterMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, ms: Date.now() - startedAt, output };
  } catch (error) {
    const err = error as { status?: number; signal?: string; stdout?: string; stderr?: string };
    if (err.signal) throw new Error(`probe was killed by ${err.signal} — it hung`);
    return {
      code: err.status ?? -1,
      ms: Date.now() - startedAt,
      output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
    };
  }
}

// A live interval stands in for the socket RUN-7's timed-out
// `POST /sessions/:id/start?wait_ms=8000` left behind.
const LEAK = "setInterval(() => {}, 1000);";

describe("exitOnceDecided", () => {
  it("leaves a leaked-handle process instead of hanging, keeping the verdict", () => {
    const { code, ms } = runScript(
      `import { exitOnceDecided } from ${JSON.stringify(MODULE)};\n${LEAK}\nexitOnceDecided(1);\n`,
      { KE2E_EXIT_GRACE_MS: "2000" },
    );
    expect(code).toBe(1);
    expect(ms).toBeLessThan(20_000);
  }, 30_000);

  it("says why it had to force the exit, so the leak stays findable", () => {
    const { output } = runScript(
      `import { exitOnceDecided } from ${JSON.stringify(MODULE)};\n${LEAK}\nexitOnceDecided(1);\n`,
      { KE2E_EXIT_GRACE_MS: "2000" },
    );
    expect(output).toContain("left a handle open");
  }, 30_000);

  it("does not delay or warn when nothing leaked", () => {
    const { code, ms, output } = runScript(
      `import { exitOnceDecided } from ${JSON.stringify(MODULE)};\nexitOnceDecided(0);\n`,
      { KE2E_EXIT_GRACE_MS: "20000" },
    );
    expect(code).toBe(0);
    // Would be ~20s if the grace timer were keeping the loop alive.
    expect(ms).toBeLessThan(10_000);
    expect(output).not.toContain("left a handle open");
  }, 40_000);

  it("waits indefinitely at grace 0, so a leak can still be debugged", () => {
    // Nothing will end this process, so the probe's own kill window is what
    // ends it — being killed IS the assertion.
    expect(() =>
      runScript(
        `import { exitOnceDecided } from ${JSON.stringify(MODULE)};\n${LEAK}\nexitOnceDecided(1);\n`,
        { KE2E_EXIT_GRACE_MS: "0" },
        6_000,
      ),
    ).toThrow(/hung/);
  }, 30_000);

  it("records the exit code without exiting when the loop is still working", () => {
    let exited: number | null = null;
    let recorded: number | null = null;
    exitOnceDecided(3, {
      exit: (value) => {
        exited = value;
      },
      setExitCode: (value) => {
        recorded = value;
      },
      warn: () => {},
    });
    expect(recorded).toBe(3);
    expect(exited).toBeNull();
  });
});
