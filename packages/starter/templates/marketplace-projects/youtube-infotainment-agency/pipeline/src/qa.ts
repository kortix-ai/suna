/** Objective checks on the final cut. Subjective quality is the critic's job (rubrics/final-cut.md). */
import { join } from "node:path";
import { channel } from "./config";
import { ffprobeJson, run } from "./lib/exec";
import { ensureDir, load, round, writeJson } from "./lib/io";
import { ep } from "./lib/paths";
import { Storyboard, Timing } from "./schemas";
import { measureLoudness } from "./audio/mix";
import { sceneWindows, seams } from "./timing";

/** Frames shown either side of each cut on the seam sheet: 0.1 s at 30 fps, enough to see a hard cut, a flash or a pop. */
const SEAM_SIDE_FRAMES = 3;

export interface QaCheck {
  name: string;
  ok: boolean;
  detail: string;
  severity: "blocker" | "warn";
}

export async function qaFinal(slug: string) {
  const p = ep(slug);
  const cfg = channel();
  const timing = load(Timing, p.timing);
  const checks: QaCheck[] = [];
  const add = (name: string, ok: boolean, detail: string, severity: "blocker" | "warn" = "blocker") =>
    checks.push({ name, ok, detail, severity });

  const probe = await ffprobeJson(p.final);
  const v = probe.streams.find((s: any) => s.codec_type === "video");
  const a = probe.streams.find((s: any) => s.codec_type === "audio");
  const duration = Number(probe.format.duration);
  const [num, den] = String(v?.r_frame_rate ?? "0/1").split("/").map(Number);
  add("video stream", !!v && v.width === cfg.video.width && v.height === cfg.video.height, `${v?.width}x${v?.height} ${v?.codec_name}`);
  add("frame rate", Math.abs(num! / den! - cfg.video.fps) < 0.01, `${round(num! / den!, 2)} fps`);
  add("audio stream", !!a && Number(a.sample_rate) === 48000, `${a?.codec_name} ${a?.sample_rate}Hz ${a?.channels}ch`);
  add("duration", Math.abs(duration - timing.total) <= 0.5, `${round(duration, 2)}s vs timing ${timing.total}s`);

  const loud = await measureLoudness(p.final, cfg.mix.target_lufs, cfg.mix.true_peak);
  const lufs = Number(loud.input_i);
  const tp = Number(loud.input_tp);
  add("integrated loudness", Math.abs(lufs - cfg.mix.target_lufs) <= 1, `${lufs} LUFS (target ${cfg.mix.target_lufs})`);
  add("true peak", tp <= cfg.mix.true_peak + 0.5, `${tp} dBTP (max ${cfg.mix.true_peak})`);

  const black = await run(["ffmpeg", "-hide_banner", "-nostats", "-i", p.final, "-vf", "blackdetect=d=0.5:pix_th=0.08", "-an", "-f", "null", "-"]);
  const blacks = [...black.stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => `${m[1]}–${m[2]}s`);
  add("black frames", blacks.length === 0, blacks.length ? `black at ${blacks.join(", ")}` : "none", "warn");

  const silence = await run(["ffmpeg", "-hide_banner", "-nostats", "-i", p.final, "-af", "silencedetect=n=-45dB:d=2", "-vn", "-f", "null", "-"]);
  const gaps = [...silence.stderr.matchAll(/silence_start: ([\d.]+)/g)].map((m) => `${round(Number(m[1]), 1)}s`);
  add("dead air", gaps.length === 0, gaps.length ? `≥2s silence at ${gaps.join(", ")}` : "none", "warn");

  // Contact sheet: one frame every ~N seconds, for the critic's watch-through.
  const every = Math.max(2, Math.round(duration / 24));
  const contact = join(p.qa, "final-contact.jpg");
  ensureDir(p.qa);
  const cols = 6;
  const rows = Math.max(1, Math.ceil(duration / every / cols));
  await run([
    "ffmpeg", "-y", "-v", "error", "-i", p.final, "-vf", `fps=1/${every},scale=320:-2,tile=${cols}x${rows}:padding=4:color=black`,
    "-frames:v", "1", "-q:v", "3", contact,
  ]);

  // Seam sheet: one row per cut between scenes, the frames either side of it, so the critic sees every
  // cut frame by frame without extracting frames itself.
  const cuts = seams(sceneWindows(load(Storyboard, p.storyboard), timing, cfg.video.fps), cfg.video.fps, SEAM_SIDE_FRAMES);
  const seamSheet = cuts.length ? join(p.qa, "final-seams.jpg") : null;
  if (seamSheet) {
    const select = cuts.map((c) => `between(n,${c.frames[0]},${c.frames[1]})`).join("+");
    await run([
      "ffmpeg", "-y", "-v", "error", "-i", p.final,
      "-vf", `select='${select}',scale=320:-2,tile=${2 * SEAM_SIDE_FRAMES}x${cuts.length}:padding=4:color=black`,
      "-frames:v", "1", "-q:v", "3", seamSheet,
    ]);
  }

  const ok = checks.every((c) => c.ok || c.severity === "warn");
  const report = {
    ok, duration: round(duration, 2), contact_sheet: contact, every_seconds: every,
    seam_sheet: seamSheet, seams: cuts.map((c) => ({ cut: `${c.from} → ${c.to}`, at: c.at, frames: c.frames })),
    checks,
  };
  writeJson(join(p.qa, "final-qa.json"), report);
  return report;
}
