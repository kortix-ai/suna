/**
 * Measured pacing of a narrated episode, from the word timings in timing.json: words per minute and the
 * silence after every punctuation mark, grouped by kind. It reports and never judges: the sound-editor
 * reads it to see where narration runs together and fixes the text (see skills/narration-and-sound).
 */
import { round } from "./lib/io";
import type { Script, Timing } from "./schemas";

export type PauseKind = "sentence" | "ellipsis" | "clause";
type Stat = { count: number; min: number; median: number; max: number };

const kindOf = (word: string): PauseKind | undefined => {
  const w = word.replace(/["'”’)\]]+$/, "");
  if (/(\.\.\.|…)$/.test(w)) return "ellipsis";
  if (/[.?!]$/.test(w)) return "sentence";
  if (/[,;:—–]$/.test(w)) return "clause";
  return undefined;
};

const stat = (xs: number[]): Stat => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : 0;
  return { count: s.length, min: round(s[0] ?? 0, 2), median: round(mid, 2), max: round(s.at(-1) ?? 0, 2) };
};

export function voiceReport(script: Script, timing: Timing) {
  const order = new Map(script.beats.map((b, i) => [b.id, i]));
  const beats = [...timing.beats].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const all: Record<PauseKind | "between_beats", number[]> = { sentence: [], ellipsis: [], clause: [], between_beats: [] };
  const rows = beats.map((b, i) => {
    const ws = b.words;
    const pauses = ws.slice(0, -1).flatMap((w, j) => {
      const kind = kindOf(w.w);
      if (!kind) return [];
      const gap = round(Math.max(0, ws[j + 1]!.start - w.end), 2);
      all[kind].push(gap);
      return [{ after: w.w, kind, gap }];
    });
    const next = beats[i + 1]?.words[0];
    if (next && ws.length) all.between_beats.push(round(next.start - ws.at(-1)!.end, 2));
    const span = ws.length ? ws.at(-1)!.end - ws[0]!.start : 0;
    return { id: b.id, words: ws.length, wpm: span > 0 ? Math.round((ws.length / span) * 60) : 0, pauses };
  });
  return {
    beats: rows,
    summary: { sentence: stat(all.sentence), ellipsis: stat(all.ellipsis), clause: stat(all.clause), between_beats: stat(all.between_beats) },
  };
}
