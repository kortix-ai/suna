// THE FILES PANEL, THE FILE VIEWER AND THE FILE SEARCH — served by the cell.
//
// The web client reads a session's files through the sandbox daemon's routes on
// the runtime origin (packages/sdk/src/core/files/client.ts): `GET /file?path=`
// lists a directory, `/file/content` and `/file/raw` read one, `/file/status`
// is the git working status, `/file/upload`, `DELETE /file`, `/file/mkdir` and
// `/file/rename` write, and `/find/file` / `/find` search names and text. A
// cell answered every one of them "unknown route" — measured 2026-09-10 on
// the user's own session: the Files panel said "Failed to load files / unknown
// route" and a page the agent had just written opened onto "This file couldn't
// be opened". Nothing in Kortix changes: the cell speaks the daemon's contract
// (apps/kortix-sandbox-agent-server/src/routes/{files,find}.ts) over its own
// tree, shape for shape.
//
// Pure over the cell's fs so every claim runs without a cell. `answer` takes
// the already-stripped route path and the request, returns a Response, or
// null when the route is not one of these.

import { CELL_CWD } from "./execenv.cell.js";

/** What the daemon lets a client reach (DEFAULT_ALLOWED_ROOTS, with the workspace first). */
export const ALLOWED_ROOTS = [CELL_CWD, "/tmp", "/home", "/opt"];

const MAX_FILES = 20_000;
const MAX_TEXT_MATCHES = 500;
const MAX_MATCHES_PER_FILE = 50;
const WALK_SKIP = new Set([".git", "node_modules", ".next", "dist", "build", ".turbo"]);

// Enough of a mime table for what a viewer decides on: image/pdf/video are
// previewed from bytes, everything else is text or octet-stream.
const MIME = {
  html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript",
  ts: "text/typescript", tsx: "text/typescript", jsx: "text/javascript", json: "application/json",
  md: "text/markdown", txt: "text/plain", csv: "text/csv", xml: "application/xml", svg: "image/svg+xml",
  yaml: "text/yaml", yml: "text/yaml", toml: "text/plain", sh: "text/x-shellscript", py: "text/x-python",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", ico: "image/x-icon",
  bmp: "image/bmp", avif: "image/avif", pdf: "application/pdf", zip: "application/zip", gz: "application/gzip",
  mp3: "audio/mpeg", wav: "audio/wav", mp4: "video/mp4", webm: "video/webm", woff: "font/woff", woff2: "font/woff2",
  ttf: "font/ttf", otf: "font/otf", wasm: "application/wasm",
};
const BINARY_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "avif", "pdf", "zip", "gz", "tar", "mp3", "wav", "mp4", "webm", "woff", "woff2", "ttf", "otf", "wasm", "exe", "bin", "so", "dylib", "sqlite", "db"]);

export const extOf = (p) => { const b = p.slice(p.lastIndexOf("/") + 1); const i = b.lastIndexOf("."); return i > 0 ? b.slice(i + 1).toLowerCase() : ""; };
export function mimeTypeFor(p, binary) {
  return MIME[extOf(p)] ?? (binary ? "application/octet-stream" : "text/plain; charset=utf-8");
}
/** A binary file: a known binary extension, or a NUL in the first 8 KiB. */
export function isLikelyBinary(bytes, p) {
  if (BINARY_EXT.has(extOf(p))) return true;
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/** Collapse `.`/`..`/`//` the way path.resolve does, for an absolute path. */
export function normalizePath(p) {
  const out = [];
  for (const seg of String(p).split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { out.pop(); continue; }
    out.push(seg);
  }
  return "/" + out.join("/");
}

/**
 * The daemon's resolvePath: absolute stays absolute, relative anchors under
 * the workspace, and the result must sit under an allowed root — or it is
 * "Access denied", a 403, exactly as the daemon answers it.
 */
export function resolvePath(raw, workspace = CELL_CWD) {
  const s = String(raw ?? "");
  const resolved = normalizePath(s.startsWith("/") ? s : `${workspace}/${s}`);
  const roots = [workspace, ...ALLOWED_ROOTS];
  if (!roots.some((root) => resolved === root || resolved.startsWith(root + "/"))) {
    throw new Error("Access denied: path outside allowed directories");
  }
  return resolved;
}

const relTo = (workspace, abs) => abs === workspace ? "" : abs.startsWith(workspace + "/") ? abs.slice(workspace.length + 1) : abs;
const json = (body, status = 200) => Response.json(body, { status });
const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const isMissing = (e) => /ENOENT|not found|no such|does not exist/i.test(e?.message ?? "");
const isDir = (e) => /EISDIR|is a directory/i.test(e?.message ?? "");

/** Every file under `dir`, workspace-relative, skipping what the daemon skips. */
export async function listAllFiles(fs, workspace = CELL_CWD) {
  const out = [];
  async function walk(dir) {
    if (out.length >= MAX_FILES) return;
    let entries;
    try { entries = await fs.readdirWithFileTypes(dir); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.isDirectory && WALK_SKIP.has(e.name)) continue;
      const abs = `${dir}/${e.name}`.replace(/\/+/g, "/");
      if (e.isDirectory) await walk(abs);
      else if (e.isFile) out.push(relTo(workspace, abs));
    }
  }
  await walk(workspace);
  return out;
}

export function dirsFromFiles(files) {
  const dirs = new Set();
  for (const f of files) { const parts = f.split("/"); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/")); }
  return [...dirs];
}

/** The daemon's ranking: substring first (earlier and shorter wins), then subsequence. */
export function fuzzyScore(candidate, query) {
  if (!query) return 1;
  const c = candidate.toLowerCase(), q = query.toLowerCase();
  const idx = c.indexOf(q);
  if (idx >= 0) return 10_000 - idx - candidate.length;
  let ci = 0;
  for (let qi = 0; qi < q.length; qi++) { ci = c.indexOf(q[qi], ci); if (ci < 0) return 0; ci++; }
  return 1_000 - candidate.length;
}

/** `GET /find?pattern=` — ripgrep's match shape, over the tree's text files. */
export async function textSearch(fs, pattern, workspace = CELL_CWD) {
  let re;
  try { re = new RegExp(pattern, "g"); } catch { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"); }
  const matches = [];
  for (const rel of await listAllFiles(fs, workspace)) {
    if (matches.length >= MAX_TEXT_MATCHES) break;
    const abs = `${workspace}/${rel}`;
    let bytes;
    try { bytes = await fs.readFileBuffer(abs); } catch { continue; }
    if (bytes.length > 5_000_000 || isLikelyBinary(bytes, abs)) continue;
    const text = new TextDecoder().decode(bytes);
    let offset = 0, perFile = 0;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && perFile < MAX_MATCHES_PER_FILE && matches.length < MAX_TEXT_MATCHES; i++) {
      const line = lines[i];
      re.lastIndex = 0;
      const subs = [];
      let m;
      while ((m = re.exec(line)) !== null) { subs.push({ start: m.index, end: m.index + m[0].length }); if (m[0].length === 0) re.lastIndex++; }
      if (subs.length) { matches.push({ path: `./${rel}`, lines: line + "\n", line_number: i + 1, absolute_offset: offset, submatches: subs }); perFile++; }
      offset += line.length + 1;
    }
  }
  return matches;
}

/**
 * Answer one of the daemon's file routes, or null. `path` is the route with
 * the `/session/<id>` prefix already stripped; `persist` is called after a
 * write so the tree goes to storage the way a tool write does.
 */
export async function filesAnswer(req, path, url, cell, workspace = CELL_CWD) {
  const isFile = path === "/file" || path.startsWith("/file/");
  const isFind = path === "/find" || path.startsWith("/find/");
  if (!isFile && !isFind) return null;
  const { fs, ready, persist } = cell;
  await ready;
  const resolve = (raw) => resolvePath(raw, workspace);
  const denied = (e) => json({ error: e.message }, 403);

  if (isFind) {
    if (path === "/find/file") {
      const query = url.searchParams.get("query") ?? "";
      const type = url.searchParams.get("type");
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10) || 100, 1000);
      const files = await listAllFiles(fs, workspace);
      const candidates = type === "directory" ? dirsFromFiles(files) : type === "file" ? files : [...files, ...dirsFromFiles(files)];
      return json(candidates.map((p) => ({ p, score: fuzzyScore(p, query) })).filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score).slice(0, limit).map((r) => r.p));
    }
    if (path === "/find") {
      const pattern = url.searchParams.get("pattern");
      if (!pattern) return json({ error: "pattern query parameter is required" }, 400);
      return json(await textSearch(fs, pattern, workspace));
    }
    return null;
  }

  // /file/raw and /file/content: one file, bytes or typed content.
  if ((path === "/file/raw" || path === "/file/content") && req.method === "GET") {
    const raw = url.searchParams.get("path");
    if (!raw) return json({ error: "path query parameter is required" }, 400);
    let resolved;
    try { resolved = resolve(raw); } catch (e) { return denied(e); }
    let bytes;
    try {
      const st = await fs.stat(resolved);
      if (st.isDirectory) return json({ error: "Path is a directory" }, 400);
      bytes = await fs.readFileBuffer(resolved);
    } catch (e) {
      if (isMissing(e)) return json({ error: "File not found" }, 404);
      if (isDir(e)) return json({ error: "Path is a directory" }, 400);
      return json({ error: String(e?.message ?? e) }, 500);
    }
    const binary = isLikelyBinary(bytes, resolved);
    if (path === "/file/raw") {
      return new Response(bytes, { status: 200, headers: { "Content-Type": mimeTypeFor(resolved, binary), "Content-Length": String(bytes.length), "Cache-Control": "no-store" } });
    }
    return binary
      ? json({ type: "binary", content: b64(bytes), encoding: "base64", mimeType: mimeTypeFor(resolved, true), size: bytes.length })
      : json({ type: "text", content: new TextDecoder().decode(bytes), mimeType: mimeTypeFor(resolved, false), size: bytes.length });
  }

  // GET /file?path= — one directory level, directories first, then by name.
  if (path === "/file" && req.method === "GET") {
    const raw = url.searchParams.get("path") ?? ".";
    let resolved;
    try { resolved = resolve(raw); } catch (e) { return denied(e); }
    let entries;
    try {
      const st = await fs.stat(resolved);
      if (!st.isDirectory) return json({ error: "Path is not a directory" }, 400);
      entries = await fs.readdirWithFileTypes(resolved);
    } catch (e) {
      if (isMissing(e)) return json({ error: "Directory not found" }, 404);
      return json({ error: String(e?.message ?? e) }, 500);
    }
    entries.sort((a, b) => ((a.isDirectory ? 0 : 1) - (b.isDirectory ? 0 : 1)) || a.name.localeCompare(b.name));
    return json(entries.map((e) => {
      const absolute = `${resolved}/${e.name}`.replace(/\/+/g, "/");
      return { name: e.name, path: relTo(workspace, absolute), absolute, type: e.isDirectory ? "directory" : "file", ignored: e.name === ".git" };
    }));
  }

  // No git in the tree yet: nothing is modified relative to a commit.
  if (path === "/file/status" && req.method === "GET") return json([]);

  if (path === "/file/upload" && req.method === "POST") {
    let form;
    try { form = await req.formData(); } catch { return json({ error: "Invalid multipart form data" }, 400); }
    const targetDir = typeof form.get("path") === "string" ? form.get("path") : undefined;
    const filenameHint = typeof form.get("filename") === "string" ? form.get("filename") : undefined;
    const safeName = (raw) => { if (typeof raw !== "string") return null; const base = raw.trim().split("/").pop(); return !base || base === "." || base === ".." || base.includes("\0") ? null : base; };
    const results = [];
    try {
      for (const [key, value] of form.entries()) {
        if (key === "path" || key === "filename" || typeof value === "string") continue;
        let dest;
        if (targetDir) {
          const name = safeName(value.name || filenameHint);
          if (!name) return json({ error: "Upload is missing a usable filename" }, 400);
          const dir = resolve(targetDir);
          dest = normalizePath(`${dir}/${name}`);
          if (dest !== dir && !dest.startsWith(dir + "/")) throw new Error("Access denied: filename escapes the target directory");
        } else if (key === "file" || key === "file[]") {
          const name = safeName(value.name || filenameHint);
          if (!name) return json({ error: "Upload is missing a usable filename" }, 400);
          dest = name;
        } else {
          dest = key;
        }
        const bytes = new Uint8Array(await value.arrayBuffer());
        // The daemon writes with `wx` and suffixes on collision: an upload never overwrites.
        let target = resolve(dest);
        if (await fs.exists(target)) {
          const i = target.lastIndexOf("."), slash = target.lastIndexOf("/");
          const ext = i > slash ? target.slice(i) : "", base = i > slash ? target.slice(0, i) : target;
          target = `${base}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}${ext}`;
        }
        await fs.mkdir(target.slice(0, target.lastIndexOf("/")) || "/", { recursive: true });
        await fs.writeFile(target, bytes);
        results.push({ path: target, size: bytes.length });
      }
    } catch (e) {
      const message = String(e?.message ?? e);
      return json({ error: message }, message.startsWith("Access denied") ? 403 : 500);
    }
    if (!results.length) return json({ error: "No files found in request body" }, 400);
    await persist();
    return json(results);
  }

  if (path === "/file" && req.method === "DELETE") {
    let raw;
    try { raw = (await req.json()).path; } catch { return json({ error: "Invalid JSON body" }, 400); }
    if (!raw) return json({ error: "Missing path in request body" }, 400);
    let resolved;
    try { resolved = resolve(raw); } catch (e) { return denied(e); }
    if (!(await fs.exists(resolved))) return json({ error: "File not found" }, 404);
    await fs.rm(resolved, { recursive: true, force: true });
    await persist();
    return json(true);
  }

  if (path === "/file/mkdir" && req.method === "POST") {
    let raw;
    try { raw = (await req.json()).path; } catch { return json({ error: "Invalid JSON body" }, 400); }
    if (!raw) return json({ error: "Missing path in request body" }, 400);
    let resolved;
    try { resolved = resolve(raw); } catch (e) { return denied(e); }
    await fs.mkdir(resolved, { recursive: true });
    await persist();
    return json(true);
  }

  if (path === "/file/rename" && req.method === "POST") {
    let from, to;
    try { ({ from, to } = await req.json()); } catch { return json({ error: "Invalid JSON body" }, 400); }
    if (!from || !to) return json({ error: "Missing from/to in request body" }, 400);
    let a, b;
    try { a = resolve(from); } catch (e) { return json({ error: `source: ${e.message}` }, 403); }
    try { b = resolve(to); } catch (e) { return json({ error: `target: ${e.message}` }, 403); }
    if (!(await fs.exists(a))) return json({ error: "Source file not found" }, 404);
    if (await fs.exists(b)) return json({ error: "Target already exists" }, 409);
    await fs.mkdir(b.slice(0, b.lastIndexOf("/")) || "/", { recursive: true });
    await fs.mv(a, b);
    await persist();
    return json({ from: a, to: b });
  }

  return json({ error: "Not found" }, 404);
}
