/**
 * YouTube Data API v3 + Analytics API v2 over plain fetch. Video bytes go straight from the sandbox
 * (Kortix connectors cap payloads at 25 MiB / 60 s). OAuth scopes needed for the refresh token:
 *   youtube.upload, youtube.force-ssl, yt-analytics.readonly   (setup: skills/youtube-publishing/SKILL.md)
 */
import { existsSync, statSync } from "node:fs";
import { channel } from "./config";
import { loadEpisode } from "./episode";
import { load, readJson, writeJson } from "./lib/io";
import { ep } from "./lib/paths";
import { Package, Publish } from "./schemas";

const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD = "https://www.googleapis.com/upload/youtube/v3";

export async function accessToken(): Promise<string> {
  const { YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN } = process.env;
  if (!YT_CLIENT_ID || !YT_CLIENT_SECRET || !YT_REFRESH_TOKEN) throw new Error("set YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: YT_CLIENT_ID, client_secret: YT_CLIENT_SECRET, refresh_token: YT_REFRESH_TOKEN, grant_type: "refresh_token" }),
  });
  if (!res.ok) throw new Error(`OAuth refresh ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function api<T>(url: string, init: RequestInit & { token: string }): Promise<T> {
  const res = await fetch(url, { ...init, headers: { authorization: `Bearer ${init.token}`, ...init.headers } });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${url.split("?")[0]} → ${res.status}: ${(await res.text()).slice(0, 800)}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** The channel the refresh token publishes to: check it before the first upload. */
export async function whoami() {
  const token = await accessToken();
  const res = await api<{ items?: { id: string; snippet: { title: string; customUrl?: string } }[] }>(`${API}/channels?part=snippet&mine=true`, { token });
  const ch = res.items?.[0];
  if (!ch) throw new Error("this Google account has no YouTube channel; mint the token signed in as the channel (or its Brand Account)");
  return { id: ch.id, title: ch.snippet.title, handle: ch.snippet.customUrl };
}

function statusBody(pkg: Package, privacy: string, publishAt?: string) {
  return {
    privacyStatus: privacy,
    ...(publishAt ? { publishAt } : {}),
    selfDeclaredMadeForKids: pkg.made_for_kids,
    // Altered/synthetic content disclosure (realistic people, places or events that didn't happen).
    containsSyntheticMedia: pkg.contains_synthetic_media,
    embeddable: true,
    license: "youtube",
  };
}

/** Publishing is irreversible-ish: only after a person approved the final gate. */
function requireFinalGate(slug: string) {
  const g = loadEpisode(slug).gates.final;
  if (g.status !== "approved" || g.by === "critic") {
    throw new Error(`final gate is ${g.status}${g.by ? ` (by ${g.by})` : ""}; a human must approve it before upload/schedule`);
  }
}

/** Resumable upload as PRIVATE, then captions + thumbnail. Idempotent: refuses if already uploaded. */
export async function upload(slug: string) {
  requireFinalGate(slug);
  const p = ep(slug);
  if (existsSync(p.publish)) throw new Error(`${slug} already uploaded (${readJson<Publish>(p.publish).url}); use \`yt youtube update\``);
  const pkg = load(Package, p.pkg);
  if (!existsSync(p.descriptionTxt)) throw new Error("run `yt sources` first (builds description.txt)");
  const description = await Bun.file(p.descriptionTxt).text();
  const token = await accessToken();
  const meta = {
    snippet: { title: pkg.chosen_title, description, tags: pkg.tags, categoryId: pkg.category_id, defaultLanguage: pkg.language, defaultAudioLanguage: pkg.language },
    status: statusBody(pkg, "private"),
  };
  const size = statSync(p.final).size;
  const init = await fetch(`${UPLOAD}/videos?uploadType=resumable&part=snippet,status`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-type": "video/mp4",
      "x-upload-content-length": String(size),
    },
    body: JSON.stringify(meta),
  });
  if (!init.ok) throw new Error(`upload init ${init.status}: ${await init.text()}`);
  const location = init.headers.get("location");
  if (!location) throw new Error("upload init returned no Location header");
  const put = await fetch(location, { method: "PUT", headers: { "content-type": "video/mp4", "content-length": String(size) }, body: Bun.file(p.final) });
  if (!put.ok) throw new Error(`upload PUT ${put.status}: ${await put.text()}`);
  const video = (await put.json()) as { id: string };

  const record: Publish = {
    video_id: video.id,
    url: `https://www.youtube.com/watch?v=${video.id}`,
    uploaded_at: new Date().toISOString(),
    privacy: "private",
    captions_uploaded: false,
    thumbnail_set: false,
  };
  writeJson(p.publish, record);

  if (existsSync(p.captions)) {
    await uploadCaptions(token, video.id, p.captions, pkg.language);
    record.captions_uploaded = true;
  }
  const thumb = [p.thumbnailPng.replace(/\.png$/, ".jpg"), p.thumbnailPng].find((f) => existsSync(f) && statSync(f).size <= 2 * 1024 * 1024);
  if (thumb) {
    // Custom thumbnails need a verified channel; a 403 here is reported, not fatal.
    const res = await fetch(`${UPLOAD}/thumbnails/set?videoId=${video.id}&uploadType=media`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": thumb.endsWith(".jpg") ? "image/jpeg" : "image/png" },
      body: Bun.file(thumb),
    });
    record.thumbnail_set = res.ok;
    if (!res.ok) console.error(`thumbnail not set (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  writeJson(p.publish, record);
  return record;
}

async function uploadCaptions(token: string, videoId: string, srtPath: string, language: string) {
  const boundary = "yt-caption-" + Date.now();
  const meta = JSON.stringify({ snippet: { videoId, language, name: "", isDraft: false } });
  const srt = await Bun.file(srtPath).text();
  const body = `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n${srt}\r\n--${boundary}--`;
  await api(`${UPLOAD}/captions?uploadType=multipart&part=snippet`, {
    method: "POST",
    token,
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });
}

/** After the final gate: schedule (private + publishAt) or publish now. */
export async function schedule(slug: string, opts: { at?: string; now?: boolean }) {
  requireFinalGate(slug);
  const p = ep(slug);
  const rec = load(Publish, p.publish);
  const pkg = load(Package, p.pkg);
  const token = await accessToken();
  const status = opts.now ? statusBody(pkg, "public") : statusBody(pkg, "private", opts.at);
  if (!opts.now && !opts.at) throw new Error("pass --at <ISO time> or --now");
  await api(`${API}/videos?part=status`, {
    method: "PUT",
    token,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: rec.video_id, status }),
  });
  rec.privacy = opts.now ? "public" : "private";
  if (opts.at) rec.publish_at = opts.at;
  writeJson(p.publish, rec);
  return rec;
}

/** Update title/description/tags (e.g. after a correction) without re-uploading. */
export async function updateMetadata(slug: string) {
  const p = ep(slug);
  const rec = load(Publish, p.publish);
  const pkg = load(Package, p.pkg);
  const token = await accessToken();
  const description = await Bun.file(p.descriptionTxt).text();
  await api(`${API}/videos?part=snippet`, {
    method: "PUT",
    token,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: rec.video_id, snippet: { title: pkg.chosen_title, description, tags: pkg.tags, categoryId: pkg.category_id } }),
  });
  return rec;
}

/** Existing coverage for a topic: what the video has to beat (used by topic-scout for originality). */
export async function search(q: string, max = 15) {
  const key = process.env.YT_API_KEY;
  const auth: Record<string, string> = key ? {} : { authorization: `Bearer ${await accessToken()}` };
  const qs = (o: Record<string, string>) => new URLSearchParams({ ...o, ...(key ? { key } : {}) }).toString();
  const s = await fetch(`${API}/search?${qs({ part: "snippet", q, type: "video", maxResults: String(max), order: "relevance", relevanceLanguage: channel().language })}`, { headers: auth });
  if (!s.ok) throw new Error(`search ${s.status}: ${await s.text()}`);
  const items = ((await s.json()) as any).items as any[];
  const ids = items.map((i) => i.id.videoId).join(",");
  const v = await fetch(`${API}/videos?${qs({ part: "statistics,contentDetails,snippet", id: ids })}`, { headers: auth });
  if (!v.ok) throw new Error(`videos ${v.status}: ${await v.text()}`);
  return (((await v.json()) as any).items as any[]).map((x) => ({
    title: x.snippet.title,
    channel: x.snippet.channelTitle,
    url: `https://www.youtube.com/watch?v=${x.id}`,
    published: x.snippet.publishedAt,
    views: Number(x.statistics.viewCount ?? 0),
    duration: x.contentDetails.duration,
  }));
}

/** Pull analytics for the post-mortem: totals + audience retention curve. */
export async function analytics(slug: string) {
  const p = ep(slug);
  const rec = load(Publish, p.publish);
  const token = await accessToken();
  const start = rec.uploaded_at.slice(0, 10);
  const end = new Date().toISOString().slice(0, 10);
  const base = `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=${start}&endDate=${end}&filters=video==${rec.video_id}`;
  const totals = await api<any>(`${base}&metrics=views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments,shares,subscribersGained`, { token });
  const retention = await api<any>(`${base}&dimensions=elapsedVideoTimeRatio&metrics=audienceWatchRatio,relativeRetentionPerformance`, { token });
  const comments = await api<any>(`${API}/commentThreads?part=snippet&videoId=${rec.video_id}&maxResults=100&order=relevance`, { token }).catch((e) => ({ error: String(e) }));
  const snapshot = { pulled_at: new Date().toISOString(), video_id: rec.video_id, totals, retention, comments };
  const file = `${p.analytics}/${end}.json`;
  writeJson(file, snapshot);
  return { file, totals: totals.rows?.[0] ?? null, columns: totals.columnHeaders?.map((c: any) => c.name) ?? [] };
}
