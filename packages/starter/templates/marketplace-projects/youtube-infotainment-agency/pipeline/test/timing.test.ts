import { describe, expect, test } from "bun:test";
import { charsToWords, estimateWords } from "../src/audio/align";
import { Script, Storyboard } from "../src/schemas";
import { chapters, description } from "../src/sources";
import { Claims, Package } from "../src/schemas";
import { cueTime, layoutTiming, sceneWindows, seams, toSrt, type BeatClip } from "../src/timing";
import { fixture } from "./helpers";

const script = () => Script.parse(fixture("03-script/script.json"));
const clips = () =>
  new Map<string, BeatClip>(
    script().beats.map((b, i) => [b.id, { id: b.id, file: `/ep/media/narration/${b.id}.wav`, duration: [4, 8, 6][i]!, words: [{ w: "Why", start: 0.1, end: 0.3 }, { w: "blue", start: 1, end: 1.4 }] }]),
  );
const timing = () => layoutTiming(script(), clips(), { provider: "stub", defaultPause: 0.5, tail: 1.5, relativeTo: "/ep" });

describe("alignment", () => {
  test("time ElevenLabs gives to punctuation is pause, not part of the word", () => {
    const chars = [..."Hi... yo."];
    const t = [[0, 0.1], [0.1, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 0.8], [0.8, 0.9], [0.9, 1.0], [1.0, 1.5]];
    const w = charsToWords(chars, t.map((x) => x[0]!), t.map((x) => x[1]!));
    expect(w).toEqual([{ w: "Hi...", start: 0, end: 0.2 }, { w: "yo.", start: 0.8, end: 1.0 }]);
  });

  test("characters → words, skipping v3 tags", () => {
    const text = "[curious] Hi there";
    const chars = [...text];
    const starts = chars.map((_, i) => i * 0.1);
    const ends = chars.map((_, i) => i * 0.1 + 0.08);
    const w = charsToWords(chars, starts, ends);
    expect(w.map((x) => x.w)).toEqual(["Hi", "there"]);
    expect(w[0]!.start).toBeCloseTo(1.0, 5);
    expect(w[1]!.end).toBeCloseTo(1.78, 5);
  });
  test("estimated words fill the duration in order", () => {
    const w = estimateWords(["a", "longer", "sentence"], 3);
    expect(w[0]!.start).toBeGreaterThan(0);
    expect(w.at(-1)!.end).toBeLessThanOrEqual(3);
    expect(w[1]!.start).toBeGreaterThan(w[0]!.start);
  });
});

describe("timing layout", () => {
  test("beats are laid end to end with pauses and a tail", () => {
    const t = timing();
    expect(t.beats.map((b) => [b.start, b.end])).toEqual([[0, 4.5], [4.5, 13], [13, 21]]);
    expect(t.total).toBe(21);
    expect(t.beats[1]!.words[0]!.start).toBeCloseTo(4.6, 5);
    expect(t.beats[0]!.audio).toBe("media/narration/b01.wav");
  });
  test("scene windows follow the beats they cover", () => {
    const w = sceneWindows(Storyboard.parse(fixture("04-visual/storyboard.json")), timing());
    expect(w.map((x) => [x.id, x.start, x.duration])).toEqual([["sc01", 0, 4.5], ["sc02", 4.5, 8.5], ["sc03", 13, 8]]);
  });
  test("scene boundaries snap to the frame grid (no concat drift)", () => {
    const t = timing();
    t.beats[0]!.end = 4.481; t.beats[1]!.start = 4.481;
    const w = sceneWindows(Storyboard.parse(fixture("04-visual/storyboard.json")), t, 30);
    expect(w[0]!.end).toBe(w[1]!.start);
    for (const x of w) expect(Math.abs(x.duration * 30 - Math.round(x.duration * 30))).toBeLessThan(0.05); // ms-rounded, frame-aligned
    expect(w.reduce((a, x) => a + x.duration, 0)).toBeCloseTo(w.at(-1)!.end, 6);
  });
  test("storyboard must cover every beat in order", () => {
    const sb = Storyboard.parse(fixture("04-visual/storyboard.json"));
    sb.scenes[1]!.beats = ["b03"];
    sb.scenes[2]!.beats = ["b02"];
    expect(() => sceneWindows(sb, timing())).toThrow(/every beat exactly once/);
  });
  test("cues resolve words, case-insensitively", () => {
    expect(cueTime(timing(), "b02", "BLUE")).toBeCloseTo(5.5, 5);
    expect(cueTime(timing(), "b02", "missing")).toBe(4.5);
  });
  test("srt cues are well-formed", () => {
    const srt = toSrt(timing());
    expect(srt.startsWith("1\n00:00:00,100 --> 00:00:01,400\nWhy blue\n")).toBe(true);
  });
});

describe("packaging text", () => {
  test("chapters need ≥3 entries of ≥10s", () => {
    expect(chapters(script(), timing())).toEqual([]); // b01 is only 4.5s
    const long = layoutTiming(script(), new Map([...clips()].map(([k, v]) => [k, { ...v, duration: 12 }])), { provider: "stub", defaultPause: 0.5, tail: 1.5, relativeTo: "/ep" });
    expect(chapters(script(), long).map((c) => c.title)).toEqual(["The question", "Scattering", "The answer"]);
  });
  test("chapter labels round up so a link never lands before its chapter starts", () => {
    const durations = [12.47, 12, 12];
    const t = layoutTiming(script(), new Map([...clips()].map(([k, v], i) => [k, { ...v, duration: durations[i]! }])), { provider: "stub", defaultPause: 0.5, tail: 1.5, relativeTo: "/ep" });
    expect(t.beats[1]!.start).toBeCloseTo(12.97, 2);
    const d = description(Package.parse(fixture("07-package/package.json")), script(), Claims.parse(fixture("02-research/claims.json")), t);
    expect(d).toContain("00:00 The question");
    expect(d).toContain("00:13 Scattering");
    expect(d).not.toContain("00:12 Scattering");
  });
  test("description carries sources and stays under 5000 chars", () => {
    const d = description(Package.parse(fixture("07-package/package.json")), script(), Claims.parse(fixture("02-research/claims.json")), timing());
    expect(d).toContain("[1] NASA Space Place");
    expect(d.length).toBeLessThan(5000);
  });
});

describe("ASR alignment", () => {
  test("maps ASR words onto script tokens and interpolates mismatches", async () => {
    const { alignTranscript } = await import("../src/audio/align");
    const tokens = ["moving", "at", "sixteen", "hundred", "kilometres", "an", "hour."];
    const asr = [
      { text: "moving", start: 1.2, end: 1.6 }, { text: "at", start: 1.6, end: 1.7 },
      { text: "1,600", start: 1.8, end: 3.4 }, { text: "km", start: 3.4, end: 3.6 },
      { text: "an", start: 3.6, end: 3.8 }, { text: "hour.", start: 3.8, end: 4.2 },
    ];
    const w = alignTranscript(tokens, asr, 4.5);
    expect(w.map((x) => x.w)).toEqual(tokens);
    expect(w[0]!.start).toBe(1.2);
    expect(w[5]!.start).toBe(3.6);
    expect(w[2]!.start).toBeGreaterThanOrEqual(1.7);
    expect(w[4]!.end).toBeLessThanOrEqual(3.6);
    for (let i = 1; i < w.length; i++) expect(w[i]!.start).toBeGreaterThanOrEqual(w[i - 1]!.start);
  });
});

describe("scene seams", () => {
  const win = (id: string, start: number, end: number) => ({ id, start, end, duration: end - start, beats: [] });
  test("one seam per cut, with the frames on both sides of it", () => {
    const s = seams([win("sc01", 0, 11.8), win("sc02", 11.8, 22.633), win("sc03", 22.633, 30)], 30, 3);
    expect(s).toEqual([
      { from: "sc01", to: "sc02", at: 11.8, frames: [351, 356] },
      { from: "sc02", to: "sc03", at: 22.633, frames: [676, 681] },
    ]);
  });
  test("a single scene has no seam", () => {
    expect(seams([win("sc01", 0, 9)], 30, 3)).toEqual([]);
  });
});
