import { describe, expect, test } from "bun:test";
import { voiceReport } from "../src/prosody";
import { Script, Timing } from "../src/schemas";
import { fixture } from "./helpers";

const script = () => Script.parse(fixture("03-script/script.json"));
const w = (t: string, start: number, end: number) => ({ w: t, start, end });
const timing = () =>
  Timing.parse({
    provider: "stub",
    total: 9,
    beats: [
      { id: "b01", start: 0, end: 4, speech_end: 3, audio: "media/narration/b01.wav",
        words: [w("Look", 0, 0.3), w("up,", 0.3, 0.6), w("friend.", 0.6, 1.0), w("Why", 1.5, 1.7), w("blue...", 1.7, 2.0), w("sky?", 2.6, 3.0)] },
      { id: "b02", start: 4, end: 9, speech_end: 6, audio: "media/narration/b02.wav",
        words: [w("Light", 4.5, 5.0), w("scatters.", 5.0, 6.0)] },
    ],
  });

describe("voice report (measured pauses, no thresholds)", () => {
  test("classifies each pause by the punctuation before it and measures it", () => {
    const r = voiceReport(script(), timing());
    const b01 = r.beats.find((b) => b.id === "b01")!;
    expect(b01.pauses).toEqual([
      { after: "up,", kind: "clause", gap: 0 },
      { after: "friend.", kind: "sentence", gap: 0.5 },
      { after: "blue...", kind: "ellipsis", gap: 0.6 },
    ]);
    expect(b01.wpm).toBe(120); // 6 words over 3.0 s of speech
  });

  test("summarises each kind across the episode, including the air between beats", () => {
    const r = voiceReport(script(), timing());
    expect(r.summary.sentence).toEqual({ count: 1, min: 0.5, median: 0.5, max: 0.5 });
    expect(r.summary.clause).toEqual({ count: 1, min: 0, median: 0, max: 0 });
    expect(r.summary.between_beats).toEqual({ count: 1, min: 1.5, median: 1.5, max: 1.5 });
  });
});
