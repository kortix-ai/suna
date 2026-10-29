/**
 * Optional generative b-roll for atmosphere shots only (never for factual diagrams). Off by default;
 * capped by share of runtime and by budget (channel.yaml → broll). Provider: fal.ai queue API.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { channel } from "./config";
import { addCost, loadEpisode, saveEpisode } from "./episode";
import { ensureDir, round } from "./lib/io";
import { ep } from "./lib/paths";
import type { Storyboard } from "./schemas";
import type { SceneWindow } from "./timing";

export function brollBudget(storyboard: Storyboard, wins: SceneWindow[], total: number) {
  const cfg = channel().broll;
  const seconds = storyboard.scenes.filter((s) => s.type === "genbroll").reduce((a, s) => a + (wins.find((w) => w.id === s.id)?.duration ?? 0), 0);
  const fraction = total ? seconds / total : 0;
  const usd = seconds * cfg.usd_per_second;
  const problems: string[] = [];
  if (seconds > 0 && !cfg.enabled) problems.push("storyboard uses genbroll scenes but broll.enabled is false in channel.yaml");
  if (fraction > cfg.max_runtime_fraction) problems.push(`genbroll is ${(fraction * 100).toFixed(0)}% of runtime (cap ${(cfg.max_runtime_fraction * 100).toFixed(0)}%)`);
  if (usd > cfg.budget_usd) problems.push(`genbroll estimate $${usd.toFixed(2)} exceeds budget $${cfg.budget_usd}`);
  return { seconds: round(seconds, 1), fraction: round(fraction, 3), usd: round(usd, 2), ok: problems.length === 0, problems };
}

export async function generateBroll(slug: string, sceneId: string, prompt: string, seconds: number) {
  const cfg = channel().broll;
  if (!cfg.enabled) throw new Error("broll is disabled (channel.yaml → broll.enabled)");
  const key = process.env.FAL_KEY;
  if (!key) throw new Error("FAL_KEY is not set");
  const dir = ep(slug).sceneAssets(sceneId);
  const out = join(dir, "broll.mp4");
  if (existsSync(out)) return { file: out, cached: true };
  const headers = { authorization: `Key ${key}`, "content-type": "application/json" };
  const submit = await fetch(`https://queue.fal.run/${cfg.model}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt, duration: String(Math.ceil(seconds)), aspect_ratio: "16:9" }),
  });
  if (!submit.ok) throw new Error(`fal submit ${submit.status}: ${await submit.text()}`);
  const job = (await submit.json()) as { status_url: string; response_url: string };
  for (let i = 0; i < 180; i++) {
    const st = (await (await fetch(job.status_url, { headers })).json()) as { status: string };
    if (st.status === "COMPLETED") break;
    if (st.status === "FAILED" || st.status === "ERROR") throw new Error(`fal job failed: ${JSON.stringify(st)}`);
    await Bun.sleep(5000);
  }
  const result = (await (await fetch(job.response_url, { headers })).json()) as { video?: { url: string } };
  if (!result.video?.url) throw new Error(`fal returned no video: ${JSON.stringify(result).slice(0, 300)}`);
  ensureDir(dir);
  await Bun.write(out, await fetch(result.video.url));
  const state = loadEpisode(slug);
  addCost(state, { stage: "scenes", provider: "fal", item: `broll ${sceneId}`, units: seconds, unit: "s", usd: round(seconds * cfg.usd_per_second, 2) });
  saveEpisode(state);
  return { file: out, cached: false };
}
