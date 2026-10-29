/**
 * Final assembly. Scenes render independently (cached by content hash, so a one-scene fix re-renders one
 * scene), are concatenated losslessly, and the soundtrack is mixed in ffmpeg against the locked timing.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { channel } from "./config";
import { addCost, loadEpisode, saveEpisode } from "./episode";
import { makeMusic, makeSfx, usdEstimate, type GenProvider } from "./audio/sound";
import { mixMaster, type Placed } from "./audio/mix";
import { ffprobeDuration, hyperframes, run, runHeavy } from "./lib/exec";
import { ensureDir, load, round, sha256, writeJson, writeText } from "./lib/io";
import { ep } from "./lib/paths";
import { Sound } from "./schemas";
import { buildScene, windows } from "./scenes";
import { cueTime, toSrt } from "./timing";

function hashDir(dir: string): string {
  const parts: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d).sort()) {
      const full = join(d, f);
      if (statSync(full).isDirectory()) walk(full);
      else parts.push(relative(dir, full) + ":" + sha256(readFileSync(full)));
    }
  };
  walk(dir);
  return sha256(parts.join("\n")).slice(0, 16);
}

export async function renderScenes(slug: string, opts: { draft?: boolean; only?: string[] } = {}) {
  const p = ep(slug);
  const { windows: wins } = windows(slug);
  const v = channel().video;
  const outDir = join(p.build, "renders");
  ensureDir(outDir);
  // Scenes render concurrently; `runHeavy` caps how many HyperFrames renders share the sandbox at once.
  const renderOne = async (win: (typeof wins)[number]) => {
    const dir = buildScene(slug, win.id);
    const quality = opts.draft ? "draft" : v.quality;
    const hash = sha256(hashDir(dir) + quality + v.fps).slice(0, 16);
    const file = join(outDir, `${win.id}-${hash}.mp4`);
    const cached = existsSync(file);
    if (!cached) {
      await runHeavy([...hyperframes(), "render", dir, "-o", file, "-f", String(v.fps), "-q", quality, "--quiet"]);
    }
    const duration = await ffprobeDuration(file);
    if (Math.abs(duration - win.duration) > 0.1) {
      throw new Error(`${win.id} rendered ${duration.toFixed(2)}s but its window is ${win.duration}s — check data-duration / CUES (yt scene retime)`);
    }
    return { id: win.id, file, cached, duration, window: win.duration };
  };
  const settled = await Promise.allSettled(wins.filter((w) => !opts.only || opts.only.includes(w.id)).map(renderOne));
  const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
  return settled.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof renderOne>>>).value);
}

/** Generate music + SFX (cached), returning placed clips for the mix. */
export async function prepareSound(slug: string, provider?: { music?: GenProvider; sfx?: GenProvider }) {
  const p = ep(slug);
  const { timing, storyboard } = windows(slug);
  const cfg = channel();
  const sound = existsSync(p.sound) ? load(Sound, p.sound) : { music: [], voice: undefined };
  const state = loadEpisode(slug);
  const beat = (id: string) => {
    const b = timing.beats.find((x) => x.id === id);
    if (!b) throw new Error(`sound.json references unknown beat ${id}`);
    return b;
  };

  const music: Placed[] = [];
  for (const cue of sound.music) {
    const start = beat(cue.from_beat).start;
    const end = beat(cue.to_beat).end;
    const prov = provider?.music ?? cfg.music.provider;
    const m = await makeMusic(p.music, cue.id, cue.prompt, end - start, prov);
    if (!m.cached && prov === "elevenlabs") {
      addCost(state, { stage: "sound", provider: "elevenlabs", item: `music ${cue.id}`, units: round(end - start, 1), unit: "s", usd: round(usdEstimate.music(end - start), 2) });
    }
    music.push({ file: m.file, at: start, duration: round(end - start), volume: cue.volume });
  }

  const sfx: Placed[] = [];
  let i = 0;
  for (const scene of storyboard.scenes) {
    for (const fx of scene.sfx) {
      i++;
      const prov = provider?.sfx ?? cfg.sfx.provider;
      const s = await makeSfx(p.sfx, `${scene.id}-${String(i).padStart(2, "0")}`, fx.prompt, fx.duration, prov);
      if (!s.cached && prov === "elevenlabs") {
        addCost(state, { stage: "sound", provider: "elevenlabs", item: `sfx ${scene.id}`, units: 1, unit: "gen", usd: round(usdEstimate.sfx(1), 2) });
      }
      sfx.push({ file: s.file, at: Math.max(0, cueTime(timing, fx.beat, fx.at_word) + fx.offset), volume: fx.volume });
    }
  }
  saveEpisode(state);

  const voice: Placed[] = timing.beats.map((b) => ({ file: join(p.root, b.audio), at: b.start, volume: 1 }));
  return { voice, music, sfx, total: timing.total };
}

export async function assemble(slug: string, opts: { draft?: boolean } = {}) {
  const p = ep(slug);
  const { timing } = windows(slug);
  const scenes = await renderScenes(slug, opts);

  // Video: concatenate the scene renders, each trimmed to its frame-aligned window.
  const list = join(p.build, "concat.txt");
  // `outpoint` trims each scene to its frame-aligned window (the renderer can add a frame), so the
  // picture never drifts against the narration however many scenes there are.
  writeFileSync(list, scenes.map((s) => `file '${s.file}'\noutpoint ${s.window.toFixed(3)}`).join("\n") + "\n");
  const video = join(p.build, "video.mp4");
  // Re-encode (not stream copy) so the outpoints are frame-exact; a copy can only cut on keyframes.
  await run([
    "ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list,
    "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-r", String(channel().video.fps), "-an", video,
  ]);

  // Audio: narration + ducked music + SFX → loudness-normalised master.
  const sound = await prepareSound(slug);
  const master = join(p.build, "master.wav");
  const loud = await mixMaster({ ...sound, out: master, workDir: p.build });

  ensureDir(p.build);
  await run([
    "ffmpeg", "-y", "-v", "error", "-i", video, "-i", master, "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-shortest", "-movflags", "+faststart", p.final,
  ]);
  writeText(p.captions, toSrt(timing));

  const report = {
    final: p.final,
    duration: await ffprobeDuration(p.final),
    expected: timing.total,
    scenes: scenes.map((s) => ({ id: s.id, cached: s.cached, duration: round(s.duration) })),
    loudness: loud,
    captions: p.captions,
  };
  writeJson(join(p.qa, "render.json"), report);
  return report;
}
