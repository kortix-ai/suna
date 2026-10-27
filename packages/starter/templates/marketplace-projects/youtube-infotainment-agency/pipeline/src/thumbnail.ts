import { copyFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { hyperframes, run, runPreview } from "./lib/exec";
import { ensureDir, writeText } from "./lib/io";
import { ep, KIT } from "./lib/paths";
import { buildProject, contactSheet } from "./scenes";

/** Scaffold 07-package/thumbnail.html from the kit template (no-op if present). */
export function scaffoldThumbnail(slug: string, text: string) {
  const p = ep(slug);
  if (existsSync(p.thumbnailHtml)) return p.thumbnailHtml;
  writeText(p.thumbnailHtml, readFileSync(join(KIT, "templates", "thumbnail.html"), "utf8").replaceAll("{{TEXT}}", text));
  return p.thumbnailHtml;
}

/**
 * Render the code-built thumbnail (1280×720) to PNG, plus a 160px "phone feed" preview — the size that
 * actually decides clicks — side by side in qa/thumbnail-preview.jpg.
 */
export async function renderThumbnail(slug: string) {
  const p = ep(slug);
  const dir = buildProject(p.thumbnailHtml, join(p.build, "thumbnail"), join(p.media, "thumbnail-assets"));
  const out = join(p.build, "thumbnail", "snap");
  ensureDir(out);
  await runPreview([...hyperframes(), "snapshot", dir, "--at", "0.5", "--no-end", "-o", out, "--describe", "false"]);
  const png = readdirSync(out).filter((f) => f.endsWith(".png")).map((f) => join(out, f))[0];
  if (!png) throw new Error("thumbnail snapshot produced no PNG");
  ensureDir(p.media);
  await run(["ffmpeg", "-y", "-v", "error", "-i", png, "-vf", "scale=1280:720", p.thumbnailPng]);
  let file = p.thumbnailPng;
  if (statSync(file).size > 2 * 1024 * 1024) {
    file = p.thumbnailPng.replace(/\.png$/, ".jpg");
    await run(["ffmpeg", "-y", "-v", "error", "-i", p.thumbnailPng, "-q:v", "2", file]);
  }
  const small = join(p.build, "thumbnail", "small.png");
  await run(["ffmpeg", "-y", "-v", "error", "-i", p.thumbnailPng, "-vf", "scale=168:94", small]);
  const preview = join(p.qa, "thumbnail-preview.jpg");
  await contactSheet([p.thumbnailPng], preview, 1, 640);
  copyFileSync(small, join(p.qa, "thumbnail-small.png"));
  return { file, preview, small: join(p.qa, "thumbnail-small.png") };
}
