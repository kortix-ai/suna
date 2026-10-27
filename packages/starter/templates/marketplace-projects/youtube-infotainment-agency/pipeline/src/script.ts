import type { Brief, Claims, Script } from "./schemas";

/** ElevenLabs v3/v4 audio tags, e.g. [curious], [whispers], [short pause]. Not spoken, not captioned. */
const TAG_RE = /\[[a-z][a-z \-']*\]/gi;

export const stripTags = (text: string) => text.replace(TAG_RE, " ").replace(/\s+/g, " ").trim();
export const words = (text: string) => stripTags(text).split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
export const estimateSeconds = (text: string, wpm: number) => (words(text).length / wpm) * 60;

export interface LintIssue {
  level: "error" | "warn";
  where: string;
  msg: string;
}

export interface ScriptStats {
  words: number;
  est_seconds: number;
  hook_seconds: number;
  beats: number;
  cited_claims: number;
}

/**
 * Structural lint for a script. Errors block `yt episode complete script`; warnings go to the critic.
 * Factual integrity rule: every `fact` beat cites ≥1 claim, and every cited claim must be `verified`.
 */
export function lintScript(script: Script, claims: Claims, brief?: Brief): { issues: LintIssue[]; stats: ScriptStats } {
  const issues: LintIssue[] = [];
  const byId = new Map(claims.claims.map((c) => [c.id, c]));
  const wpm = script.target_wpm;
  let total = 0;
  let hook = 0;
  const cited = new Set<string>();

  for (const b of script.beats) {
    const secs = estimateSeconds(b.narration, wpm);
    total += secs + (b.pause_after ?? 0);
    if (b.act === "hook") hook += secs;
    const n = words(b.narration).length;
    if (n === 0) issues.push({ level: "error", where: b.id, msg: "beat has no spoken words" });
    if (n > 95) issues.push({ level: "warn", where: b.id, msg: `${n} words (~${secs.toFixed(0)}s) in one beat; split it so visuals can keep pace` });
    if (b.kind === "fact" && b.claims.length === 0) issues.push({ level: "error", where: b.id, msg: "fact beat cites no claim" });
    for (const cid of b.claims) {
      cited.add(cid);
      const c = byId.get(cid);
      if (!c) issues.push({ level: "error", where: b.id, msg: `unknown claim ${cid}` });
      else if (c.status !== "verified") issues.push({ level: "error", where: b.id, msg: `claim ${cid} is ${c.status}, not verified` });
    }
    for (const e of b.emphasis) {
      if (!stripTags(b.narration).toLowerCase().includes(e.toLowerCase())) {
        issues.push({ level: "error", where: b.id, msg: `emphasis word "${e}" not in narration` });
      }
    }
  }

  if (script.beats[0]?.act !== "hook") issues.push({ level: "error", where: "beats[0]", msg: "script must open with a hook beat" });
  if (hook > 30) issues.push({ level: "warn", where: "hook", msg: `hook runs ~${hook.toFixed(0)}s; aim for ≤30s` });
  if (brief) {
    const target = brief.target_minutes * 60;
    if (total < target * 0.7 || total > target * 1.3) {
      issues.push({ level: "warn", where: "script", msg: `~${(total / 60).toFixed(1)} min vs target ${brief.target_minutes} min` });
    }
  }
  const verifiedUnused = claims.claims.filter((c) => c.status === "verified" && !cited.has(c.id)).length;
  if (verifiedUnused > claims.claims.length * 0.6) {
    issues.push({ level: "warn", where: "claims", msg: `${verifiedUnused} verified claims unused; is the script too thin?` });
  }

  return {
    issues,
    stats: {
      words: script.beats.reduce((a, b) => a + words(b.narration).length, 0),
      est_seconds: Math.round(total),
      hook_seconds: Math.round(hook),
      beats: script.beats.length,
      cited_claims: cited.size,
    },
  };
}

/** Human-readable script for the script gate: narration + citations inline. */
export function scriptMarkdown(script: Script, claims: Claims): string {
  const byId = new Map(claims.claims.map((c) => [c.id, c]));
  const src = new Map(claims.sources.map((s) => [s.id, s]));
  const lines = [`# ${script.title}`, ""];
  if (script.voice_direction) lines.push(`> Voice: ${script.voice_direction}`, "");
  let act = "";
  for (const b of script.beats) {
    if (b.act !== act) {
      act = b.act;
      lines.push(`## ${act[0]!.toUpperCase()}${act.slice(1)}`, "");
    }
    lines.push(`**${b.id}** · _${b.kind}_ · 🎬 ${b.visual_intent}`, "", b.narration, "");
    for (const cid of b.claims) {
      const c = byId.get(cid);
      if (!c) continue;
      // Every supporting source, not just the first: a claim's chain is often Avogadro + area + packing,
      // and attributing the whole sum to whichever source happened to be listed first misleads the
      // human reading this at the script gate.
      const links = c.source_ids
        .map((sid) => src.get(sid))
        .filter((s): s is NonNullable<typeof s> => Boolean(s))
        .map((s) => `[${s.publisher}](${s.url})`);
      lines.push(`- \`${cid}\` ${c.text} — ${links.length ? links.join(", ") : "?"}`);
    }
    if (b.claims.length) lines.push("");
  }
  return lines.join("\n");
}
