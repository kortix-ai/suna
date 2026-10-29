import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { brollBudget } from "./broll";
import { STAGE_SPECS, type Stage } from "./episode";
import { load, readJson } from "./lib/io";
import { ep } from "./lib/paths";
import { Brief, Claims, FactCheck, Package, Publish, Script, Sound, Storyboard, Timing, VoiceCast } from "./schemas";
import { lintScript } from "./script";
import { sceneWindows } from "./timing";

export interface Finding {
  level: "error" | "warn";
  msg: string;
}

/** Stage exit criteria beyond "the file exists": schemas, lints and cross-artifact consistency. */
export function validateStage(slug: string, stage: Stage): Finding[] {
  const p = ep(slug);
  const out: Finding[] = [];
  const err = (msg: string) => out.push({ level: "error", msg });
  const warn = (msg: string) => out.push({ level: "warn", msg });
  const guard = (fn: () => void) => { try { fn(); } catch (e) { err((e as Error).message); } };

  for (const f of STAGE_SPECS[stage].outputs(p)) if (!existsSync(f)) err(`missing ${f}`);
  if (out.length) return out;

  guard(() => {
    switch (stage) {
      case "topic": {
        const b = load(Brief, p.brief);
        if (b.slug !== slug) err(`brief.slug ${b.slug} ≠ episode ${slug}`);
        if (b.originality.existing_coverage.length < 3) warn("fewer than 3 existing videos surveyed for originality");
        if (b.originality.score < 3) err(`originality ${b.originality.score}/5 — find a sharper angle or another topic`);
        break;
      }
      case "research": {
        const c = load(Claims, p.claims);
        if (readFileSync(p.dossier, "utf8").length < 1500) warn("dossier is thin (<1500 chars)");
        if (c.claims.length < 8) warn(`only ${c.claims.length} claims`);
        break;
      }
      case "factcheck": {
        const c = load(Claims, p.claims);
        const fc = load(FactCheck, p.factcheck);
        const checked = new Set(fc.results.map((r) => r.claim_id));
        const missing = c.claims.filter((x) => !checked.has(x.id)).map((x) => x.id);
        if (missing.length) err(`fact-check skipped ${missing.join(", ")}`);
        if (c.claims.some((x) => x.status === "unverified")) err("claims still unverified; run `yt claims apply`");
        break;
      }
      case "script": {
        const s = load(Script, p.script);
        const c = load(Claims, p.claims);
        const { issues } = lintScript(s, c, existsSync(p.brief) ? load(Brief, p.brief) : undefined);
        for (const i of issues) out.push({ level: i.level, msg: `${i.where}: ${i.msg}` });
        break;
      }
      case "voice": {
        const s = load(Script, p.script);
        const t = load(Timing, p.timing);
        if (t.beats.map((b) => b.id).join() !== s.beats.map((b) => b.id).join()) err("timing.json is stale vs script.json; run `yt voice`");
        for (const b of t.beats) if (!existsSync(join(p.root, b.audio))) err(`missing narration ${b.audio} (yt media pull?)`);
        if (t.provider === "elevenlabs") {
          const c = VoiceCast.safeParse(existsSync(p.voiceCast) ? JSON.parse(readFileSync(p.voiceCast, "utf8")) : undefined);
          if (!c.success) err("03-script/voice.json is missing or invalid: cast the episode (yt cast library / yt cast adopt)");
        }
        break;
      }
      case "storyboard": {
        const sb = load(Storyboard, p.storyboard);
        const t = load(Timing, p.timing);
        const wins = sceneWindows(sb, t);
        for (const w of wins) {
          if (w.duration > 45) warn(`${w.id} holds ${w.duration.toFixed(0)}s — long static scenes lose viewers; split or plan camera moves`);
          if (w.duration < 1.5) warn(`${w.id} is only ${w.duration.toFixed(1)}s`);
        }
        const budget = brollBudget(sb, wins, t.total);
        for (const pr of budget.problems) err(pr);
        for (const s of sb.scenes) if (s.type === "genbroll" && !s.broll_prompt) err(`${s.id} is genbroll but has no broll_prompt`);
        for (const s of sb.scenes) {
          if (s.type !== "genbroll" && !s.styleframe) warn(`${s.id} has no style frame: write its styleframe_prompt and run \`bin/yt storyboard frames ${slug}\``);
        }
        break;
      }
      case "scenes": {
        const sb = load(Storyboard, p.storyboard);
        for (const s of sb.scenes) {
          if (!existsSync(p.scene(s.id))) { err(`missing scene ${s.id}`); continue; }
          const check = join(p.qa, "scenes", `${s.id}-check.json`);
          if (!existsSync(check)) err(`${s.id} never passed \`yt scene check\``);
          else if (!readJson<{ ok: boolean }>(check).ok) err(`${s.id} failed its last \`yt scene check\``);
        }
        break;
      }
      case "sound": {
        const snd = load(Sound, p.sound);
        if (snd.music.length === 0) warn("no music cues");
        break;
      }
      case "render": {
        const qa = join(p.qa, "final-qa.json");
        if (!existsSync(qa)) err("run `yt qa final` first");
        else if (!readJson<{ ok: boolean }>(qa).ok) err("final QA has blocking failures");
        break;
      }
      case "package": {
        const pkg = load(Package, p.pkg);
        if (!pkg.titles.some((t) => t.text === pkg.chosen_title)) warn("chosen_title is not among the scored titles");
        if (!existsSync(p.descriptionTxt)) err("run `yt sources` to build description.txt");
        if (!existsSync(p.thumbnailPng)) err("run `yt thumb render`");
        break;
      }
      case "publish": {
        load(Publish, p.publish);
        break;
      }
      default:
        break;
    }
  });
  return out;
}
