/**
 * Storyboard helpers. The image model draws each scene's style frame (its key frame) from the art
 * director's `styleframe_prompt`, all scenes at once. The style frame sheet tiles every scene's style
 * frame into one image, so the art director and the critic look at the whole board once instead of
 * opening each PNG while they work.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { channel } from "./config";
import { addCost, loadEpisode, saveEpisode } from "./episode";
import { run } from "./lib/exec";
import { ensureDir, load, readJson, round, writeJson } from "./lib/io";
import { generateImage, openaiKey } from "./lib/openai";
import { ep } from "./lib/paths";
import { Storyboard, type Scene } from "./schemas";

/** Tile width; 3 columns of 640 px keep a 6-scene sheet readable in one image. */
const COLUMNS = 3;
const TILE = { w: 640, h: 360 };

export async function styleframeSheet(slug: string): Promise<{ sheet: string; scenes: string[] }> {
  const p = ep(slug);
  const frames = load(Storyboard, p.storyboard).scenes
    .filter((s) => s.styleframe)
    .map((s) => ({ id: s.id, file: isAbsolute(s.styleframe!) ? s.styleframe! : join(p.root, s.styleframe!) }));
  if (!frames.length) throw new Error(`no style frames in ${p.storyboard}: set scenes[].styleframe first`);

  const rows = Math.ceil(frames.length / COLUMNS);
  const fit = `scale=${TILE.w}:${TILE.h}:force_original_aspect_ratio=decrease,pad=${TILE.w}:${TILE.h}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
  const graph = [
    ...frames.map((_, i) => `[${i}:v]${fit}[f${i}]`),
    `${frames.map((_, i) => `[f${i}]`).join("")}concat=n=${frames.length}:v=1:a=0,tile=${COLUMNS}x${rows}:padding=4:color=black`,
  ].join(";");
  ensureDir(p.qa);
  const sheet = join(p.qa, "styleframes.jpg");
  await run(["ffmpeg", "-y", "-v", "error", ...frames.flatMap((f) => ["-i", f.file]), "-filter_complex", graph, "-frames:v", "1", "-q:v", "3", sheet]);
  return { sheet, scenes: frames.map((f) => f.id) };
}

/** "'a', 'b' and 'c'", or "none". */
function quoted(words: string[]) {
  const q = words.map((w) => `'${w}'`);
  return q.length > 1 ? `${q.slice(0, -1).join(", ")} and ${q.at(-1)}` : (q[0] ?? "none");
}

/** The request text: a frame of the finished video (not an illustration of one), the channel's look, and the only words allowed. */
function framePrompt(title: string, scene: Scene, look: string) {
  return [
    "A single screenshot of a finished YouTube video, exactly as a viewer sees it on YouTube: one full-bleed 16:9 video frame, edge to edge. " +
      "Keep everything important inside the central 16:9 area, because the image will be cropped to 16:9. " +
      `The video: '${title}', an animated explainer. ${look}`,
    `This frame shows: ${scene.styleframe_prompt}`,
    `The only words in the frame are: ${quoted(scene.on_screen_text)}. Draw nothing the frame description does not name: no extra characters, titles or labels. ` +
      "No borders, no captions, no subtitles, no video player interface, no watermark.",
  ].join("\n\n");
}

/**
 * Draw the style frames of every scene that has a `styleframe_prompt` and no frame yet (or of the named
 * scenes, again), all at once. A failed scene is reported and the rest are kept.
 */
export async function drawStyleframes(slug: string, opts: { scenes?: string[] } = {}) {
  const p = ep(slug);
  const cfg = channel();
  const scenes = load(Storyboard, p.storyboard).scenes;
  const file = (id: string) => join(p.styleframes, `${id}.png`);
  const prompted = scenes.filter((s) => s.styleframe_prompt);
  if (!prompted.length) throw new Error(`no scene in ${p.storyboard} has a styleframe_prompt: write one per scene first`);
  for (const id of opts.scenes ?? []) {
    if (!prompted.some((s) => s.id === id)) throw new Error(`${id} is not a scene with a styleframe_prompt`);
  }
  const todo = opts.scenes ? prompted.filter((s) => opts.scenes!.includes(s.id)) : prompted.filter((s) => !existsSync(file(s.id)));
  const skipped = prompted.filter((s) => !todo.includes(s)).map((s) => s.id);

  const rateIn = cfg.rates.openai_image_text_input_per_1m_tokens;
  const rateOut = cfg.rates.openai_image_output_per_1m_tokens;
  if (todo.length) {
    openaiKey();
    if (rateIn === undefined || rateOut === undefined) {
      throw new Error("channel.yaml → rates needs openai_image_text_input_per_1m_tokens and openai_image_output_per_1m_tokens");
    }
  }

  const title = loadEpisode(slug).title;
  const tmp = mkdtempSync(join(tmpdir(), "yt-frames-"));
  ensureDir(p.styleframes);
  const results = await Promise.allSettled(
    todo.map(async (s) => {
      const { png, usage } = await generateImage({ model: cfg.styleframes.model, prompt: framePrompt(title, s, cfg.styleframes.look), size: cfg.styleframes.size, quality: cfg.styleframes.quality });
      const raw = join(tmp, `${s.id}.png`);
      writeFileSync(raw, png);
      // The widest 16:9 window, centred, at the saved width.
      const fit = `crop='min(iw,ih*16/9)':'min(ih,iw*9/16)',scale=${cfg.styleframes.width}:-2`;
      await run(["ffmpeg", "-y", "-v", "error", "-i", raw, "-vf", fit, "-frames:v", "1", file(s.id)]);
      return { id: s.id, usd: (usage.input_tokens * rateIn! + usage.output_tokens * rateOut!) / 1e6, tokens: usage.output_tokens };
    }),
  );
  rmSync(tmp, { recursive: true, force: true });

  const drawn = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const failed = results.flatMap((r, i) => (r.status === "rejected" ? [{ scene: todo[i]!.id, error: String(r.reason?.message ?? r.reason) }] : []));

  if (drawn.length) {
    const sb = readJson<{ scenes: { id: string; styleframe?: string }[] }>(p.storyboard);
    for (const s of sb.scenes) if (drawn.some((d) => d.id === s.id)) s.styleframe = relative(p.root, file(s.id));
    writeJson(p.storyboard, sb);
    const state = loadEpisode(slug);
    for (const d of drawn) addCost(state, { stage: "storyboard", provider: "openai", item: `styleframe ${d.id}`, units: d.tokens, unit: "image output tokens", usd: round(d.usd, 4) });
    saveEpisode(state);
  }
  const anyFrame = load(Storyboard, p.storyboard).scenes.some((s) => s.styleframe);
  return {
    drawn: drawn.map((d) => d.id),
    skipped,
    failed,
    usd: round(drawn.reduce((a, d) => a + d.usd, 0), 2),
    sheet: anyFrame ? (await styleframeSheet(slug)).sheet : undefined,
  };
}
