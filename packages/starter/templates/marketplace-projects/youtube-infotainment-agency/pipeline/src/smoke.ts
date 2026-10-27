/**
 * Offline end-to-end test: copies the fixture episode to a temp dir and drives it through the real state
 * machine and every deterministic stage (stub voice/music/SFX, real HyperFrames renders, real ffmpeg mix,
 * real QA). No API keys, no network beyond what is already installed.
 */
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeStage, decideGate, loadEpisode, newEpisode, nextAction, saveEpisode, startStage, type Stage } from "./episode";
import { applyFactCheck } from "./claims";
import { setChannel } from "./config";
import { load, writeJson, writeText } from "./lib/io";
import { ep, PIPELINE } from "./lib/paths";
import { qaFinal } from "./qa";
import { assemble } from "./render";
import { Claims, FactCheck, Script } from "./schemas";
import { checkScene, retimeScenes, windows } from "./scenes";
import { scriptMarkdown } from "./script";
import { writeSources } from "./sources";
import { renderThumbnail } from "./thumbnail";
import { validateStage } from "./validate";
import { voice } from "./voice";
import { prepareSound } from "./render";

export async function smoke(opts: { keep?: boolean } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "yt-smoke-"));
  process.env.YT_EPISODES_DIR = join(tmp, "episodes");
  process.env.YT_BUILD_DIR = join(tmp, "build");
  process.env.YT_OFFLINE = "1";
  setChannel(undefined);
  const slug = "_smoke";
  const p = ep(slug);
  cpSync(join(PIPELINE, "test", "fixtures", "episode"), p.root, { recursive: true });
  const t0 = Date.now();
  const log: string[] = [];
  const step = (msg: string) => { log.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${msg}`); if (process.env.YT_VERBOSE) console.error(msg); };

  const st = newEpisode(slug, "Why is the sky blue? (smoke)");
  saveEpisode(st);

  const run = async (stage: Stage, work: () => Promise<void> | void) => {
    const s = loadEpisode(slug);
    const next = nextAction(s);
    if (next.action !== "run_stage" || next.stage !== stage) throw new Error(`expected to run ${stage}, state machine says ${JSON.stringify(next)}`);
    startStage(s, stage);
    saveEpisode(s);
    await work();
    const errors = validateStage(slug, stage).filter((f) => f.level === "error");
    if (errors.length) throw new Error(`${stage} failed validation:\n${errors.map((e) => "  " + e.msg).join("\n")}`);
    const s2 = loadEpisode(slug);
    completeStage(s2, stage);
    saveEpisode(s2);
    step(`✔ ${stage}`);
  };
  const approve = (gate: "topic" | "script" | "storyboard" | "final") => {
    const s = loadEpisode(slug);
    if (s.gates[gate].mode !== "auto") decideGate(s, gate, true, "smoke-test");
    saveEpisode(s);
  };

  await run("topic", () => {});
  approve("topic");
  await run("research", () => {});
  await run("factcheck", () => {
    const { claims } = applyFactCheck(load(Claims, p.claims), load(FactCheck, p.factcheck));
    writeJson(p.claims, claims);
  });
  await run("script", () => writeText(p.scriptMd, scriptMarkdown(load(Script, p.script), load(Claims, p.claims))));
  approve("script");
  await run("voice", async () => { await voice(slug, "stub"); });
  await run("storyboard", () => {});
  approve("storyboard");
  await run("scenes", async () => {
    retimeScenes(slug);
    for (const w of windows(slug).windows) {
      const c = await checkScene(slug, w.id, { frames: 4 });
      if (!c.ok) throw new Error(`scene ${w.id} failed check:\n${JSON.stringify(c, null, 2).slice(0, 3000)}`);
      step(`  scene ${w.id} ok (${c.hyperframes.warnings} warnings)`);
    }
  });
  await run("sound", async () => { await prepareSound(slug, { music: "stub", sfx: "stub" }); });
  let render: Awaited<ReturnType<typeof assemble>> | undefined;
  let qa: Awaited<ReturnType<typeof qaFinal>> | undefined;
  await run("render", async () => {
    render = await assemble(slug, { draft: true });
    qa = await qaFinal(slug);
  });
  await run("package", async () => {
    writeSources(slug);
    await renderThumbnail(slug);
  });
  approve("final");

  const assertions = {
    final_exists: existsSync(p.final),
    duration_matches_timing: !!render && Math.abs(render.duration - render.expected) <= 0.5,
    loudness_on_target: !!qa && qa.checks.find((c) => c.name === "integrated loudness")!.ok,
    final_qa_ok: !!qa?.ok,
    contact_sheet: !!qa && existsSync(qa.contact_sheet),
    seam_sheet: !!qa?.seam_sheet && existsSync(qa.seam_sheet) && qa.seams.length > 0,
    captions: existsSync(p.captions),
    sources_page: existsSync(p.sourcesMd),
    description: existsSync(p.descriptionTxt),
    thumbnail: existsSync(p.thumbnailPng),
    next_is_publish: (() => { const n = nextAction(loadEpisode(slug)); return n.action === "run_stage" && n.stage === "publish"; })(),
  };
  const ok = Object.values(assertions).every(Boolean);
  const result = { ok, seconds: Math.round((Date.now() - t0) / 1000), assertions, render, qa: qa && { ok: qa.ok, checks: qa.checks }, log, dir: opts.keep || !ok ? tmp : undefined };
  if (!opts.keep && ok) rmSync(tmp, { recursive: true, force: true });
  if (!ok) process.exitCode = 1;
  return result;
}
