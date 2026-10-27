/**
 * Heavy media (narration, music, renders) never goes into git — Kortix warns at 10 MiB per file and
 * 512 MiB per repo. It is mirrored to S3-compatible storage (Cloudflare R2 recommended) and indexed in
 * media.lock.json, which IS committed, so any fresh sandbox can `yt media pull` and resume.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ensureDir, readJson, sha256File, writeJson } from "./lib/io";
import { ep } from "./lib/paths";

type Lock = Record<string, { sha256: string; size: number; key: string }>;

function client() {
  const { MEDIA_S3_ENDPOINT, MEDIA_S3_BUCKET, MEDIA_S3_ACCESS_KEY_ID, MEDIA_S3_SECRET_ACCESS_KEY } = process.env;
  if (!MEDIA_S3_BUCKET || !MEDIA_S3_ACCESS_KEY_ID || !MEDIA_S3_SECRET_ACCESS_KEY) {
    throw new Error("media storage not configured: set MEDIA_S3_ENDPOINT, MEDIA_S3_BUCKET, MEDIA_S3_ACCESS_KEY_ID, MEDIA_S3_SECRET_ACCESS_KEY");
  }
  return new Bun.S3Client({
    endpoint: MEDIA_S3_ENDPOINT,
    bucket: MEDIA_S3_BUCKET,
    accessKeyId: MEDIA_S3_ACCESS_KEY_ID,
    secretAccessKey: MEDIA_S3_SECRET_ACCESS_KEY,
  });
}

const prefix = () => (process.env.MEDIA_S3_PREFIX ?? "yt-infotainment").replace(/\/$/, "");

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const full = join(dir, f);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Files that belong in storage: everything under media/ plus the final render. */
function mediaFiles(slug: string) {
  const p = ep(slug);
  const files = walk(p.media).map((f) => ({ abs: f, rel: relative(p.root, f) }));
  if (existsSync(p.final)) files.push({ abs: p.final, rel: "render/final.mp4" });
  return files;
}

export async function push(slug: string) {
  const p = ep(slug);
  const s3 = client();
  const lock: Lock = existsSync(p.mediaLock) ? readJson<Lock>(p.mediaLock) : {};
  let uploaded = 0;
  for (const f of mediaFiles(slug)) {
    const sha = sha256File(f.abs);
    if (lock[f.rel]?.sha256 === sha) continue;
    const key = `${prefix()}/episodes/${slug}/${f.rel}`;
    await s3.write(key, Bun.file(f.abs));
    lock[f.rel] = { sha256: sha, size: statSync(f.abs).size, key };
    uploaded++;
  }
  writeJson(p.mediaLock, Object.fromEntries(Object.entries(lock).sort()));
  return { uploaded, total: Object.keys(lock).length };
}

export async function pull(slug: string) {
  const p = ep(slug);
  if (!existsSync(p.mediaLock)) return { downloaded: 0, total: 0 };
  const s3 = client();
  const lock = readJson<Lock>(p.mediaLock);
  let downloaded = 0;
  for (const [rel, entry] of Object.entries(lock)) {
    const abs = rel === "render/final.mp4" ? p.final : join(p.root, rel);
    if (existsSync(abs) && sha256File(abs) === entry.sha256) continue;
    ensureDir(join(abs, ".."));
    await Bun.write(abs, s3.file(entry.key));
    downloaded++;
  }
  return { downloaded, total: Object.keys(lock).length };
}

/** A time-limited link to a stored object (e.g. the final cut, for a human reviewer). */
export function presign(slug: string, rel: string, seconds = 7 * 24 * 3600) {
  const lock = readJson<Lock>(ep(slug).mediaLock);
  const entry = lock[rel];
  if (!entry) throw new Error(`${rel} is not in media.lock.json; run \`yt media push ${slug}\``);
  return client().presign(entry.key, { expiresIn: seconds });
}
