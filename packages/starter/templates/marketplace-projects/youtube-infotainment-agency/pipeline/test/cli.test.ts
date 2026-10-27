import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { newEpisode, saveEpisode } from "../src/episode";
import { PIPELINE } from "../src/lib/paths";
import { tempEpisode } from "./helpers";

/** Run the real CLI as a process, the way agents call it. */
function yt(args: string[], env: Record<string, string | undefined> = {}) {
  const r = Bun.spawnSync(["bun", join(PIPELINE, "src", "cli.ts"), ...args], { env: { ...process.env, YT_OFFLINE: "1", ...env } });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

describe("yt CLI", () => {
  test("--help after a subcommand prints help instead of running it", () => {
    const r = yt(["smoke", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("yt smoke");
    expect(r.stdout).not.toContain('"assertions"');
  });

  test("episode timing reports per-stage minutes", () => {
    tempEpisode("_timing");
    const st = newEpisode("_timing", "t");
    st.stages.topic.history = [{ attempt: 1, started_at: "2026-10-20T08:00:00Z", finished_at: "2026-10-20T08:03:00Z", outcome: "done" }];
    saveEpisode(st);
    const r = yt(["episode", "timing", "_timing"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ stages: [{ stage: "topic", attempts: 1, minutes: 3 }], wall_minutes: 3 });
  });
});
