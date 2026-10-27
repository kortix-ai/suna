import { existsSync } from "node:fs";
import { channel } from "./config";
import { load, writeText } from "./lib/io";
import { ep } from "./lib/paths";
import { Claims, Package, Script, Timing } from "./schemas";
import { stripTags } from "./script";

const mmss = (t: number) => {
  const s = Math.floor(t);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
};

/**
 * Chapter labels round *up*: a chapter link must never land before the content boundary it names.
 * A beat at 34.97 s prints 00:35 (inside its own beat) rather than 00:34 (a second into the previous
 * one). The ≥10 s rule is still evaluated on the raw times in `chapters()`, so this only affects the
 * rendered label. Claim timestamps on the sources page keep `mmss` (floor) — they mark where in the
 * video a quote is supported, and half a second either way is not a boundary.
 */
const mmssChapter = (t: number) => mmss(Math.ceil(t));

/** YouTube chapters: first at 00:00, at least 3, each ≥10s. Returns [] when the rules can't be met. */
export function chapters(script: Script, timing: Timing): { t: number; title: string }[] {
  const start = new Map(timing.beats.map((b) => [b.id, b.start]));
  const out = script.beats.filter((b) => b.chapter).map((b) => ({ t: start.get(b.id) ?? 0, title: b.chapter! }));
  if (!out.length) return [];
  if (out[0]!.t > 0) out.unshift({ t: 0, title: "Intro" });
  else out[0]!.t = 0;
  const ok = out.length >= 3 && out.every((c, i) => (out[i + 1]?.t ?? timing.total) - c.t >= 10);
  return ok ? out : [];
}

/** Sources in order of first citation in the script; uncited verified claims' sources go last. */
export function orderedSources(script: Script, claims: Claims) {
  const byClaim = new Map(claims.claims.map((c) => [c.id, c]));
  const order: string[] = [];
  const push = (sid: string) => { if (!order.includes(sid)) order.push(sid); };
  for (const b of script.beats) for (const cid of b.claims) byClaim.get(cid)?.source_ids.forEach(push);
  for (const c of claims.claims) if (c.status === "verified") c.source_ids.forEach(push);
  const byId = new Map(claims.sources.map((s) => [s.id, s]));
  return order.map((id) => byId.get(id)!).filter(Boolean);
}

/** The public sources page: every claim the video makes, the quote that supports it, and where it's from. */
export function sourcesMarkdown(script: Script, claims: Claims, timing?: Timing): string {
  const src = new Map(claims.sources.map((s) => [s.id, s]));
  const byClaim = new Map(claims.claims.map((c) => [c.id, c]));
  const start = new Map(timing?.beats.map((b) => [b.id, b.start]) ?? []);
  const lines = [`# Sources & notes — ${script.title}`, "", "Every factual statement in the video, the passage that supports it, and where it comes from.", ""];
  for (const b of script.beats) {
    for (const cid of b.claims) {
      const c = byClaim.get(cid);
      if (!c) continue;
      const at = start.has(b.id) ? ` (${mmss(start.get(b.id)!)})` : "";
      lines.push(`### ${c.text}${at}`);
      for (const q of c.quotes) {
        const s = src.get(q.source_id);
        lines.push(`> ${q.quote}`, `>`, `> — ${s?.authors.length ? s.authors.join(", ") + ", " : ""}*${s?.title}*, ${s?.publisher}${s?.published ? ` (${s.published})` : ""}${q.locator ? `, ${q.locator}` : ""}. ${s?.url}`, "");
      }
    }
  }
  lines.push("## Bibliography", "");
  orderedSources(script, claims).forEach((s, i) => lines.push(`${i + 1}. ${s.authors.length ? s.authors.join(", ") + ". " : ""}*${s.title}*. ${s.publisher}${s.published ? `, ${s.published}` : ""}. ${s.url} (${s.tier} source, accessed ${s.accessed_at.slice(0, 10)})`));
  return lines.join("\n") + "\n";
}

/** Final description: body + chapters + sources (+ disclosure), kept under YouTube's 5000-char limit. */
export function description(pkg: Package, script: Script, claims: Claims, timing: Timing, sourcesUrl?: string): string {
  const parts = [pkg.description.trim()];
  const ch = chapters(script, timing);
  if (ch.length) parts.push("Chapters\n" + ch.map((c) => `${mmssChapter(c.t)} ${c.title}`).join("\n"));
  const srcs = orderedSources(script, claims);
  const url = sourcesUrl || channel().publish.sources_base_url;
  const head = url ? `Sources & notes (every claim, with quotes): ${url}` : "Sources";
  let block = head + "\n" + srcs.map((s, i) => `[${i + 1}] ${s.publisher} — ${s.title}: ${s.url}`).join("\n");
  const credit = "Written, researched and animated with an AI-assisted pipeline; every claim is checked against the sources above.";
  const budget = 5000 - parts.join("\n\n").length - credit.length - 8;
  if (block.length > budget) {
    const keep: string[] = [head];
    for (const [i, s] of srcs.entries()) {
      const line = `[${i + 1}] ${s.publisher} — ${s.title}: ${s.url}`;
      if (keep.join("\n").length + line.length + 40 > budget) { keep.push(`…and ${srcs.length - i} more on the sources page.`); break; }
      keep.push(line);
    }
    block = keep.join("\n");
  }
  parts.push(block, credit);
  return parts.join("\n\n");
}

export function writeSources(slug: string) {
  const p = ep(slug);
  const script = load(Script, p.script);
  const claims = load(Claims, p.claims);
  const timing = existsSync(p.timing) ? load(Timing, p.timing) : undefined;
  writeText(p.sourcesMd, sourcesMarkdown(script, claims, timing));
  let desc: string | undefined;
  if (existsSync(p.pkg) && timing) {
    desc = description(load(Package, p.pkg), script, claims, timing);
    writeText(p.descriptionTxt, desc);
  }
  return { sources: p.sourcesMd, description: desc ? p.descriptionTxt : null, chars: desc?.length ?? 0 };
}

export { mmss, stripTags };
