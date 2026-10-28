import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { channel } from "../src/config";
import { stageVerdict } from "../src/critic";
import { newEpisode, saveEpisode } from "../src/episode";
import { packet, request, requireHumanApproval } from "../src/gate";
import { writeJson } from "../src/lib/io";
import { ep } from "../src/lib/paths";
import { parseShowOutput, parseSubmitOutput } from "../src/lib/review";
import { Review, reviewVerdict } from "../src/schemas";
import { fakeKortixReview, tempEpisode } from "./helpers";

describe("kortix review submit output", () => {
  test("reads review_item_id (what the CLI actually returns)", () => {
    expect(parseSubmitOutput('{"review_item_id":"00000000-0000-4000-8000-000000000001","status":"needs_you"}')).toBe("00000000-0000-4000-8000-000000000001");
  });
  test("still accepts id / item.id / data.id shapes", () => {
    expect(parseSubmitOutput('{"id":"a"}')).toBe("a");
    expect(parseSubmitOutput('{"item":{"id":"b"}}')).toBe("b");
    expect(parseSubmitOutput('{"data":{"review_item_id":"c"}}')).toBe("c");
  });
  test("falls back to scanning non-JSON output", () => {
    expect(parseSubmitOutput('✓ submitted\n{"review_item_id": "d"')).toBe("d");
    expect(parseSubmitOutput("nothing here")).toBeUndefined();
  });
});

describe("kortix review show output", () => {
  test("reads the real item shape: status + feedback + acted_by + detail", () => {
    const real = JSON.stringify({
      review_item_id: "r-1", kind: "decision", status: "approved", agent: "showrunner",
      acted_by: "u-1", acted_at: "2026-10-13T12:22:19.740Z", feedback: "2",
      detail: { episode: "001-x", gate: "final", packet: "/workspace/episodes/001-x/qa/gate-final.md" },
    });
    expect(parseShowOutput(real)).toEqual({
      verdict: "approved", note: "2", by: "u-1",
      detail: { episode: "001-x", gate: "final", packet: "/workspace/episodes/001-x/qa/gate-final.md" },
    });
  });
  test("a pending item has no note and a needs_you status", () => {
    expect(parseShowOutput(JSON.stringify({ status: "needs_you" }))).toMatchObject({ verdict: "needs_you", note: undefined });
  });
});

describe("critic verdict", () => {
  const base = { stage: "script", rubric: "rubrics/script.md", reviewed_at: "2026-10-20T08:30:00Z", scores: { hook: 3 }, overall: 3.2, pass: false };
  const issue = (severity: "blocker" | "major" | "minor") => ({ severity, where: "b02", problem: "p", fix: "f" });

  test("a stage passes with minor issues only, whatever the scores", () => {
    expect(reviewVerdict(Review.parse({ ...base, issues: [issue("minor"), issue("minor")] }))).toMatchObject({ pass: true, minors: 2 });
  });
  test("any major or blocker fails it, however high the scores", () => {
    expect(reviewVerdict(Review.parse({ ...base, overall: 4.8, issues: [issue("major")] }))).toMatchObject({ pass: false, majors: 1 });
    expect(reviewVerdict(Review.parse({ ...base, overall: 4.8, issues: [issue("blocker")] }))).toMatchObject({ pass: false, blockers: 1 });
  });
  test("an auto-fail fails it", () => {
    expect(reviewVerdict(Review.parse({ ...base, auto_fail: ["captions missing"] })).pass).toBe(false);
  });
});

describe("scene reviews", () => {
  const issue = (severity: "blocker" | "major" | "minor", problem = "p") => ({ severity, where: "4.2s", problem, fix: "f" });
  const sceneReview = (overall: number, issues: ReturnType<typeof issue>[]) =>
    Review.parse({ stage: "scenes", rubric: "rubrics/scene.md", reviewed_at: "2026-10-21T11:40:00Z", scores: { motion_quality: overall }, overall, pass: true, issues });
  const save = (stage: string, r: Review) => writeJson(ep("_smoke").review(stage), r);

  beforeEach(() => tempEpisode());

  test("the verdict reads one review per scene; no aggregate file is needed", () => {
    save("scenes-sc01", sceneReview(4, [issue("minor")]));
    save("scenes-sc02", sceneReview(3, [issue("major")]));
    expect(stageVerdict("_smoke", "scenes")).toMatchObject({ pass: false, blockers: 0, majors: 1, minors: 1, overall: 3.5, failing: ["sc02"] });
  });
  test("every scene passing passes the stage", () => {
    save("scenes-sc01", sceneReview(4, []));
    save("scenes-sc02", sceneReview(4.4, [issue("minor")]));
    expect(stageVerdict("_smoke", "scenes")).toMatchObject({ pass: true, failing: [] });
  });
  test("other stages read their single review file", () => {
    save("script", { ...sceneReview(4, [issue("major")]), stage: "script" });
    expect(stageVerdict("_smoke", "script")).toMatchObject({ pass: false, majors: 1, failing: ["script"] });
  });
  test("no review on file is an error, not a pass", () => {
    expect(() => stageVerdict("_smoke", "scenes")).toThrow(/no critic review/);
  });
  test("issues left open after the fix rounds reach the final gate packet", () => {
    saveEpisode(newEpisode("_smoke", "t"));
    save("scenes-sc02", sceneReview(3.7, [issue("major", "packets teleport on every loop")]));
    const body = packet("_smoke", "final");
    expect(body).toContain("## Scenes critic review");
    expect(body).toContain("sc02");
    expect(body).toContain("[major] 4.2s: packets teleport on every loop");
  });
  test("scenes get one fix round by default", () => {
    expect(channel().critic.scene_fix_rounds).toBe(1);
  });
});

describe("gate requests", () => {
  const review = (stage: string, severity?: "major" | "minor") =>
    Review.parse({ stage, rubric: `rubrics/${stage}.md`, reviewed_at: "2026-10-21T13:30:00Z", scores: { x: 4 }, overall: 4, pass: true,
      issues: severity ? [{ severity, where: "w", problem: "p", fix: "f" }] : [] });

  beforeEach(() => {
    tempEpisode();
    saveEpisode(newEpisode("_smoke", "t"));
  });

  test("a gate is not requested before the critic has reviewed its stage", async () => {
    await expect(request("_smoke", "topic", {})).rejects.toThrow(/critic/);
  });
  test("a gate is not requested while the critic's review fails", async () => {
    writeJson(ep("_smoke").review("topic"), review("topic", "major"));
    await expect(request("_smoke", "topic", {})).rejects.toThrow(/fails/);
  });
  test("a passing review lets the gate be requested", async () => {
    writeJson(ep("_smoke").review("topic"), review("topic", "minor"));
    expect(await request("_smoke", "topic", {})).toMatchObject({ submitted: false });
  });
  test("the final gate needs the final-cut review (stage render)", async () => {
    writeJson(ep("_smoke").review("final"), review("render"));
    await expect(request("_smoke", "final", {})).rejects.toThrow(/render-review\.json.*final-review\.json/s);
  });
});

// episode.yaml is a file any agent in the sandbox can write. Only a person can approve a Kortix review
// item (`project.review.act`), so the irreversible steps re-read the item itself.
describe("a person's approval is re-read from the Kortix review inbox", () => {
  const PATH = process.env.PATH;
  const item = (o: object = {}) => ({ review_item_id: "r-final", status: "approved", acted_by: "u-1", detail: { episode: "_smoke", gate: "final" }, ...o });
  /** episode.yaml claims the final gate is approved, whatever the review item says. */
  const approvedOnDisk = (review_id?: string) => {
    const st = newEpisode("_smoke", "t");
    Object.assign(st.gates.final, { status: "approved", by: "u-1", review_id });
    saveEpisode(st);
  };

  beforeEach(() => tempEpisode());
  afterEach(() => { process.env.PATH = PATH; });

  test("an approved item for this episode and gate passes", async () => {
    approvedOnDisk("r-final");
    fakeKortixReview("r-final", item());
    await expect(requireHumanApproval("_smoke", "final")).resolves.toBeUndefined();
  });
  test("an item still waiting for the person fails, whatever episode.yaml says", async () => {
    approvedOnDisk("r-final");
    fakeKortixReview("r-final", item({ status: "needs_you" }));
    await expect(requireHumanApproval("_smoke", "final")).rejects.toThrow(/r-final is needs_you/);
  });
  test("an approved item for another episode or another gate fails", async () => {
    approvedOnDisk("r-final");
    fakeKortixReview("r-final", item({ detail: { episode: "002-other", gate: "final" } }));
    await expect(requireHumanApproval("_smoke", "final")).rejects.toThrow(/for 002-other final/);
    fakeKortixReview("r-final", item({ detail: { episode: "_smoke", gate: "script" } }));
    await expect(requireHumanApproval("_smoke", "final")).rejects.toThrow(/for _smoke script/);
  });
  test("a gate with no review item, or one that can't be read, fails", async () => {
    approvedOnDisk(undefined);
    await expect(requireHumanApproval("_smoke", "final")).rejects.toThrow(/no review item/);
    approvedOnDisk("r-final");
    fakeKortixReview("r-other", item());
    await expect(requireHumanApproval("_smoke", "final")).rejects.toThrow(/could not read review item r-final/);
  });
  test("a gate episode.yaml does not show as approved fails before any lookup", async () => {
    saveEpisode(newEpisode("_smoke", "t"));
    fakeKortixReview("r-final", item());
    await expect(requireHumanApproval("_smoke", "final")).rejects.toThrow(/episode\.yaml: closed/);
  });
});
