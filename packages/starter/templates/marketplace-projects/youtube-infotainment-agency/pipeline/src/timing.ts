import { relative } from "node:path";
import { round } from "./lib/io";
import type { Script, Storyboard, Timing } from "./schemas";

export interface BeatClip {
  id: string;
  file: string;
  duration: number;
  words: { w: string; start: number; end: number }[];
}

/**
 * Lay beats end to end: each beat's narration, then its pause. Word times become absolute.
 * The last beat gets `tail` seconds so music and the final visual can breathe.
 */
export function layoutTiming(
  script: Script,
  clips: Map<string, BeatClip>,
  opts: { provider: string; defaultPause: number; tail: number; relativeTo: string },
): Timing {
  let cursor = 0;
  const beats = script.beats.map((b, i) => {
    const clip = clips.get(b.id);
    if (!clip) throw new Error(`no narration for ${b.id}`);
    const start = round(cursor);
    const speechEnd = round(start + clip.duration);
    const isLast = i === script.beats.length - 1;
    const end = round(speechEnd + (b.pause_after ?? opts.defaultPause) + (isLast ? opts.tail : 0));
    cursor = end;
    return {
      id: b.id,
      start,
      end,
      speech_end: speechEnd,
      audio: relative(opts.relativeTo, clip.file),
      words: clip.words.map((w) => ({ w: w.w, start: round(start + w.start), end: round(start + w.end) })),
    };
  });
  return { provider: opts.provider, total: round(cursor), beats };
}

export interface SceneWindow {
  id: string;
  start: number;
  end: number;
  duration: number;
  beats: string[];
}

/**
 * Scene windows come from the beats each scene covers. Scenes must cover every beat once, in order.
 * Boundaries snap to the frame grid so rendered scenes concatenate without drift against the audio.
 */
export function sceneWindows(storyboard: Storyboard, timing: Timing, fps = 30): SceneWindow[] {
  const snap = (t: number) => round(Math.round(t * fps) / fps);
  const order = timing.beats.map((b) => b.id);
  const covered = storyboard.scenes.flatMap((s) => s.beats);
  if (covered.join() !== order.join()) {
    throw new Error(`storyboard must cover every beat exactly once, in order.\n  beats:  ${order.join(" ")}\n  scenes: ${covered.join(" ")}`);
  }
  const byId = new Map(timing.beats.map((b) => [b.id, b]));
  return storyboard.scenes.map((s) => {
    const start = snap(byId.get(s.beats[0]!)!.start);
    const end = snap(byId.get(s.beats.at(-1)!)!.end);
    return { id: s.id, start, end, duration: round(end - start), beats: s.beats };
  });
}

/**
 * The cuts between consecutive scenes, each with the frame range `side` frames either side of it
 * (`frames` = [first, last] frame index of the final film), so a cut can be seen frame by frame.
 */
export function seams(wins: SceneWindow[], fps: number, side: number) {
  return wins.slice(1).map((w, i) => {
    const n = Math.round(w.start * fps);
    return { from: wins[i]!.id, to: w.id, at: w.start, frames: [n - side, n + side - 1] as [number, number] };
  });
}

/** Absolute time of a word cue (first occurrence of `word` in `beat`, case-insensitive), else beat start. */
export function cueTime(timing: Timing, beatId: string, word?: string): number {
  const b = timing.beats.find((x) => x.id === beatId);
  if (!b) throw new Error(`unknown beat ${beatId}`);
  if (!word) return b.start;
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const first = norm(word.split(/\s+/)[0] ?? "");
  const hit = b.words.find((w) => norm(w.w) === first);
  return hit ? hit.start : b.start;
}

/** SRT captions from word timings: ≤42 chars and ≤3s per cue, broken at beat edges. */
export function toSrt(timing: Timing, maxChars = 42, maxDur = 3): string {
  const cues: { start: number; end: number; text: string }[] = [];
  for (const b of timing.beats) {
    let cur: { start: number; end: number; text: string } | undefined;
    for (const w of b.words) {
      if (cur && (cur.text.length + 1 + w.w.length > maxChars || w.end - cur.start > maxDur)) {
        cues.push(cur);
        cur = undefined;
      }
      cur = cur ? { ...cur, end: w.end, text: `${cur.text} ${w.w}` } : { start: w.start, end: w.end, text: w.w };
    }
    if (cur) cues.push(cur);
  }
  const ts = (t: number) => {
    const ms = Math.round(t * 1000);
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
    const pad = (n: number, l = 2) => String(n).padStart(l, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
  };
  return cues.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`).join("\n");
}
