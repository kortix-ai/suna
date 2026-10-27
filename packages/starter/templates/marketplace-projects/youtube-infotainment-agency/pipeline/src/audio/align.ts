import type { z } from "zod";
import type { Word } from "../schemas";

type W = z.infer<typeof Word>;

/**
 * Convert ElevenLabs character alignment into word timings. Bracketed audio tags ([curious]) are
 * skipped: they are directions, not speech. A word ends at its last spoken letter or digit: the model
 * gives trailing punctuation ("hour." "now...") the time of the pause that follows it, so counting that
 * time as the word would hide the pause.
 */
export function charsToWords(chars: string[], starts: number[], ends: number[]): W[] {
  const out: W[] = [];
  let buf = "";
  let s = 0;
  let e = 0;
  let inTag = false;
  const flush = () => {
    const w = buf.trim();
    if (w && /[\p{L}\p{N}]/u.test(w)) out.push({ w, start: s, end: e });
    buf = "";
  };
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (ch === "[") { flush(); inTag = true; continue; }
    if (inTag) { if (ch === "]") inTag = false; continue; }
    if (/\s/.test(ch)) { flush(); continue; }
    if (!buf) s = starts[i] ?? e;
    buf += ch;
    if (/[\p{L}\p{N}]/u.test(ch)) e = ends[i] ?? s;
  }
  flush();
  return out;
}

/** Spread words over a known speech duration, proportional to their length (for providers without alignment). */
export function estimateWords(tokens: string[], duration: number, lead = 0.05): W[] {
  const weights = tokens.map((t) => Math.max(2, t.length) + 1.5);
  const total = weights.reduce((a, b) => a + b, 0);
  const usable = Math.max(0, duration - lead * 2);
  let t = lead;
  return tokens.map((w, i) => {
    const d = (weights[i]! / total) * usable;
    const word = { w, start: t, end: t + d * 0.9 };
    t += d;
    return word;
  });
}

/**
 * Map ASR word timings onto the script's own tokens. ASR may write words differently ("1,600" for
 * "sixteen hundred"), so tokens are matched by normalised text in order; unmatched script tokens get
 * times interpolated between their matched neighbours.
 */
export function alignTranscript(tokens: string[], asr: { text: string; start: number; end: number }[], duration: number): W[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const out: (W | null)[] = tokens.map(() => null);
  let j = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = norm(tokens[i]!);
    for (let k = j; k < Math.min(asr.length, j + 4); k++) {
      if (norm(asr[k]!.text) === t) {
        out[i] = { w: tokens[i]!, start: asr[k]!.start, end: asr[k]!.end };
        j = k + 1;
        break;
      }
    }
  }
  // Interpolate gaps between anchors (or the clip edges).
  let i = 0;
  while (i < out.length) {
    if (out[i]) { i++; continue; }
    let e = i;
    while (e < out.length && !out[e]) e++;
    const from = i > 0 ? out[i - 1]!.end : (asr[0]?.start ?? 0.05);
    const to = e < out.length ? out[e]!.start : Math.max(from, (asr.at(-1)?.end ?? duration));
    const slice = estimateWords(tokens.slice(i, e), Math.max(0.1, to - from), 0);
    slice.forEach((w, n) => (out[i + n] = { w: w.w, start: from + w.start, end: from + w.end }));
    i = e;
  }
  return out as W[];
}
