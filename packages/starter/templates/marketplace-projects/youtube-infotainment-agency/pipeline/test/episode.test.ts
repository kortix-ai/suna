import { beforeEach, describe, expect, test } from "bun:test";
import { brollBudget } from "../src/broll";
import { channel, setChannel } from "../src/config";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { completeStage, decideGate, newEpisode, nextAction, reopen, requestGate, startStage, failStage, stageTimings, STAGES, STAGE_SPECS, type EpisodeState, type Stage } from "../src/episode";
import { ep } from "../src/lib/paths";
import { Storyboard } from "../src/schemas";
import { fixture, tempEpisode } from "./helpers";

beforeEach(() => tempEpisode());

describe("episode state machine", () => {
  test("starts at topic", () => {
    expect(nextAction(newEpisode("_smoke", "t"))).toMatchObject({ action: "run_stage", stage: "topic", agent: "topic-scout" });
  });
  test("a human gate blocks the next stage until approved", () => {
    const st = newEpisode("_smoke", "t");
    startStage(st, "topic");
    completeStage(st, "topic");
    expect(nextAction(st)).toMatchObject({ action: "await_gate", gate: "topic", mode: "human" });
    expect(() => startStage(st, "research")).toThrow(/gate topic/);
    expect(() => decideGate(st, "topic", true, "critic")).toThrow(/human/);
    decideGate(st, "topic", true, "reviewer");
    expect(nextAction(st)).toMatchObject({ action: "run_stage", stage: "research" });
  });
  test("an approved gate can't be re-requested", () => {
    const st = newEpisode("_smoke", "t");
    startStage(st, "topic");
    completeStage(st, "topic");
    requestGate(st, "topic");
    decideGate(st, "topic", true, "reviewer");
    expect(() => requestGate(st, "topic")).toThrow(/already approved/);
  });
  test("cannot skip ahead", () => {
    const st = newEpisode("_smoke", "t");
    expect(() => startStage(st, "script")).toThrow(/topic is pending/);
  });
  test("completing requires the declared outputs", () => {
    const st = newEpisode("_smoke", "t");
    startStage(st, "topic");
    completeStage(st, "topic");
    decideGate(st, "topic", true, "reviewer");
    startStage(st, "research");
    process.env.YT_EPISODES_DIR = "/nonexistent";
    expect(() => completeStage(st, "research")).toThrow(/missing outputs/);
  });
  test("repeated failures block and escalate", () => {
    const st = newEpisode("_smoke", "t");
    for (let i = 0; i < 4; i++) { startStage(st, "topic"); failStage(st, "topic", "weak angle"); }
    expect(nextAction(st, 4)).toMatchObject({ action: "blocked", stage: "topic" });
  });
  test("rejected gate blocks; reopen resets downstream", () => {
    const st = newEpisode("_smoke", "t");
    startStage(st, "topic");
    completeStage(st, "topic");
    decideGate(st, "topic", false, "reviewer", "too generic");
    expect(nextAction(st)).toMatchObject({ action: "blocked" });
    reopen(st, "topic", "too generic");
    expect(st.gates.topic.status).toBe("closed");
    expect(nextAction(st)).toMatchObject({ action: "run_stage", stage: "topic", attempt: 2 });
  });
  test("auto gates don't wait", () => {
    const cfg = structuredClone(channel());
    cfg.gates.topic = "auto";
    setChannel(cfg);
    const st = newEpisode("_smoke", "t");
    startStage(st, "topic");
    completeStage(st, "topic");
    expect(nextAction(st)).toMatchObject({ action: "run_stage", stage: "research" });
    setChannel(undefined);
  });
});

/** Run every stage before `until` (writing any missing declared output), with all gates on auto. */
function runUntil(st: EpisodeState, until: Stage) {
  for (const stage of STAGES.slice(0, STAGES.indexOf(until))) {
    for (const f of STAGE_SPECS[stage].outputs(ep(st.slug))) if (!existsSync(f)) { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, "{}"); }
    startStage(st, stage);
    completeStage(st, stage);
  }
}
function autoGates() {
  const cfg = structuredClone(channel());
  for (const g of Object.keys(cfg.gates) as (keyof typeof cfg.gates)[]) cfg.gates[g] = "auto";
  setChannel(cfg);
}

describe("stage graph (parallel stages)", () => {
  beforeEach(() => autoGates());

  test("after the storyboard, scenes, sound and package can all start", () => {
    const st = newEpisode("_smoke", "t");
    runUntil(st, "scenes");
    const next = nextAction(st);
    expect(next).toMatchObject({ action: "run_stage", stage: "scenes" });
    expect(next.action === "run_stage" && next.also.map((a) => a.stage)).toEqual(["sound", "package"]);
    startStage(st, "scenes");
    startStage(st, "sound");
    startStage(st, "package");
  });

  test("render waits for both scenes and sound", () => {
    const st = newEpisode("_smoke", "t");
    runUntil(st, "scenes");
    startStage(st, "scenes");
    completeStage(st, "scenes");
    expect(() => startStage(st, "render")).toThrow(/sound is pending/);
    const next = nextAction(st);
    expect(next.action === "run_stage" && [next.stage, ...next.also.map((a) => a.stage)]).toEqual(["sound", "package"]);
  });

  test("the final gate covers render and package; publish waits for it", () => {
    const cfg = structuredClone(channel());
    cfg.gates.final = "human";
    setChannel(cfg);
    const st = newEpisode("_smoke", "t");
    runUntil(st, "publish");
    expect(nextAction(st)).toMatchObject({ action: "await_gate", gate: "final" });
    expect(() => startStage(st, "publish")).toThrow(/gate final/);
    decideGate(st, "final", true, "reviewer");
    expect(nextAction(st)).toMatchObject({ action: "run_stage", stage: "publish" });
  });

  test("reopening scenes invalidates render but keeps sound and package", () => {
    const st = newEpisode("_smoke", "t");
    runUntil(st, "publish");
    reopen(st, "scenes", "sc02 reads too slow");
    expect(st.stages.scenes.status).toBe("pending");
    expect(st.stages.render.status).toBe("pending");
    expect(st.stages.sound.status).toBe("done");
    expect(st.stages.package.status).toBe("done");
  });
});

describe("stage timing", () => {
  test("every attempt is recorded with its outcome", () => {
    const st = newEpisode("_smoke", "t");
    startStage(st, "topic");
    failStage(st, "topic", "weak angle");
    startStage(st, "topic");
    completeStage(st, "topic");
    const h = st.stages.topic.history;
    expect(h.map((a) => [a.attempt, a.outcome])).toEqual([[1, "failed"], [2, "done"]]);
    expect(h.every((a) => a.started_at && a.finished_at)).toBe(true);
  });

  test("timings sum each stage's attempts and the episode's active time", () => {
    const st = newEpisode("_smoke", "t");
    st.stages.scenes.history = [
      { attempt: 1, started_at: "2026-10-20T08:00:00Z", finished_at: "2026-10-20T08:30:00Z", outcome: "failed" },
      { attempt: 2, started_at: "2026-10-20T08:40:00Z", finished_at: "2026-10-20T09:10:00Z", outcome: "done" },
    ];
    st.stages.sound.history = [{ attempt: 1, started_at: "2026-10-20T08:05:00Z", finished_at: "2026-10-20T08:25:00Z", outcome: "done" }];
    const t = stageTimings(st);
    expect(t.stages.find((s) => s.stage === "scenes")).toMatchObject({ attempts: 2, minutes: 60 });
    expect(t.stages.find((s) => s.stage === "sound")).toMatchObject({ attempts: 1, minutes: 20 });
    // Wall clock from the first start to the last finish; sound overlapped scenes.
    expect(t.wall_minutes).toBe(70);
  });
});

describe("b-roll caps", () => {
  test("genbroll scenes need broll.enabled and stay under the runtime cap", () => {
    const sb = Storyboard.parse(fixture("04-visual/storyboard.json"));
    sb.scenes[1]!.type = "genbroll";
    const wins = [{ id: "sc01", start: 0, end: 5, duration: 5, beats: ["b01"] }, { id: "sc02", start: 5, end: 15, duration: 10, beats: ["b02"] }, { id: "sc03", start: 15, end: 20, duration: 5, beats: ["b03"] }];
    const b = brollBudget(sb, wins, 20);
    expect(b.ok).toBe(false);
    expect(b.problems.join()).toMatch(/disabled|enabled is false/);
    expect(b.problems.join()).toMatch(/50% of runtime/);
  });
});
