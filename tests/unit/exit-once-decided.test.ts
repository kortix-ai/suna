import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exitOnceDecided } from "../src/core/exit-once-decided";

// Release gate run 34510198802, api shard 4 printed
// `results: 82/84 passed · 1 failed · 1 skipped · 0 todo` at 18:44:39, then sat
// idle for 40 minutes until the job's 60-minute cap killed it. `cancelled`
// replaced the real verdict, poisoned `needs.api.result`, and failed
// `full suite + quality gates` for the whole promote. The runner had set
// `process.exitCode` and returned, so it waited on an event loop that one
// leaked handle kept alive forever.
//
// The grace timer runs on a fake clock. A pending fake timer is the leaked
// handle: the process is still alive when the grace period ends.

const MODULE = join(import.meta.dirname, "..", "src", "core", "exit-once-decided.ts");

function decide(code: number) {
  const exit = vi.fn();
  const setExitCode = vi.fn();
  exitOnceDecided(code, { exit, setExitCode });
  return { exit, setExitCode };
}

describe("exitOnceDecided", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("GITHUB_ACTIONS", "");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("records the verdict at once and exits with it when the grace period ends", () => {
    vi.stubEnv("KE2E_EXIT_GRACE_MS", "2000");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { exit, setExitCode } = decide(1);

    expect(setExitCode).toHaveBeenCalledWith(1);
    vi.advanceTimersByTime(1_999);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("says why it had to force the exit, so the leak stays findable", () => {
    vi.stubEnv("KE2E_EXIT_GRACE_MS", "2000");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    decide(1);
    vi.advanceTimersByTime(2_000);

    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain("left a handle open");
  });

  it("defaults the grace period to 15 s", () => {
    vi.stubEnv("KE2E_EXIT_GRACE_MS", undefined);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { exit } = decide(1);

    vi.advanceTimersByTime(14_999);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("waits indefinitely at grace 0, so a leak can still be debugged", () => {
    vi.stubEnv("KE2E_EXIT_GRACE_MS", "0");
    const { exit, setExitCode } = decide(1);

    expect(setExitCode).toHaveBeenCalledWith(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(exit).not.toHaveBeenCalled();
  });

  // The CONN-27 rule is "Do not hide a leaked connection by forcing the test
  // process to exit." A warning buried in a 40,000-line CI log is close enough
  // to hidden, so under GitHub Actions the notice becomes an annotation.
  it("raises a workflow annotation under GitHub Actions, so the leak is on the record", () => {
    vi.stubEnv("KE2E_EXIT_GRACE_MS", "2000");
    vi.stubEnv("GITHUB_ACTIONS", "true");
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    decide(1);
    vi.advanceTimersByTime(2_000);

    const output = write.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("::error title=ke2e leaked a handle::");
    // One line, or Actions truncates the annotation at the first newline.
    const annotation = output.split("\n").find((line) => line.startsWith("::error"));
    expect(annotation).toContain("left a handle open");
  });

  it("stays a plain warning off CI, where an Actions command is just noise", () => {
    vi.stubEnv("KE2E_EXIT_GRACE_MS", "2000");
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    decide(1);
    vi.advanceTimersByTime(2_000);

    expect(write.mock.calls.map((call) => String(call[0])).join("")).not.toContain("::error");
    expect(String(warn.mock.calls[0]?.[0])).toContain("left a handle open");
  });

  // Only a real process shows that the grace timer never holds an idle loop
  // open. Nothing sleeps: a 10-minute grace that kept the loop alive would hit
  // the probe's kill window and throw.
  it("does not delay or warn when nothing leaked", () => {
    vi.useRealTimers();
    const dir = mkdtempSync(join(tmpdir(), "ke2e-exit-"));
    const file = join(dir, "probe.ts");
    writeFileSync(file, `import { exitOnceDecided } from ${JSON.stringify(MODULE)};\nexitOnceDecided(0);\n`);

    const output = execFileSync("bun", [file], {
      env: { ...process.env, KE2E_EXIT_GRACE_MS: "600000" },
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(output).not.toContain("left a handle open");
  });
});
