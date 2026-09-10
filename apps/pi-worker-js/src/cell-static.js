// THE PREVIEW SERVER, SERVED BY THE CELL.
//
// Opening an HTML file in the viewer frames it from the sandbox's static file
// server: port 3211, `GET /open?path=/workspace/x.html`, after `GET /health`
// answers (packages/sdk core/session/static-file-preview.ts). A cell has one
// port, so on the user's session the viewer read "Starting preview server…"
// for thirty seconds and gave up (2026-09-10). The proxy now sends a cell's
// port-3211 traffic to the cell under `/static`, and this module answers it
// the way apps/kortix-sandbox-agent-server/src/static-web.ts does: `/open`
// injects a <base href> so `./style.css` resolves through `/abs/…` of the SAME
// public prefix, `/abs/<path>` serves assets by mime, both refuse anything
// outside /workspace and /tmp, and a directory answers its index.html.
//
// Pure over the cell's fs; every claim runs without a cell.

import { CELL_CWD } from "./execenv.cell.js";
import { extOf, isLikelyBinary, mimeTypeFor, normalizePath } from "./cell-files.js";

export const STATIC_PREFIX = "/static";
/** What the daemon's server lets a page reach. */
export const STATIC_ROOTS = [CELL_CWD, "/tmp"];
const DENIED = ["/etc", "/proc", "/sys", "/dev", "/root", "/home"];

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Access-Control-Allow-Headers": "*" };
const text = (body, status = 200) => new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS } });
const underAny = (p, roots) => roots.some((r) => p === r || p.startsWith(r + "/"));

/** An absolute path under an allowed root, or null. */
export function toAbsPath(raw) {
  const s = String(raw ?? "").trim();
  if (!s.startsWith("/")) return null;
  const abs = normalizePath(s);
  if (underAny(abs, DENIED)) return null;
  return underAny(abs, STATIC_ROOTS) ? abs : null;
}

const HTML_EXT = new Set(["html", "htm", "xhtml"]);
export const isHtml = (p) => HTML_EXT.has(extOf(p));

/**
 * The public base of THIS server as the browser sees it — `X-Forwarded-Prefix`
 * when the proxy names it (absolute, or a path under the forwarded origin),
 * else the forwarded origin, else the request's own. The <base href> must be
 * built from it: a relative asset resolves against the page URL, which is the
 * proxy's `/v1/p/<session>/3211/open`, and only this prefix + `/abs/…` reaches
 * the tree.
 */
export function publicBaseUrl(req, url) {
  const strip = (v) => v.replace(/\/+$/, "");
  const origin = () => {
    const proto = req.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");
    const host = req.headers.get("x-forwarded-host") || url.host;
    return /^https?$/.test(proto) ? `${proto}://${host}` : `${url.protocol}//${url.host}`;
  };
  const xfp = req.headers.get("x-forwarded-prefix");
  if (xfp) {
    if (/^https?:\/\//i.test(xfp)) { try { const u = new URL(xfp); u.search = ""; u.hash = ""; return strip(u.toString()); } catch { /* fall through */ } }
    else return strip(new URL(`/${xfp.replace(/^\/+/, "")}`, `${origin()}/`).toString());
  }
  return strip(origin());
}

const escapeHtml = (v) => v.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

/** The daemon's <base> injection, hash-link fix included, verbatim in effect. */
export function injectBase(html, absFilePath, baseUrl) {
  const dir = absFilePath.slice(0, absFilePath.lastIndexOf("/")) || "/";
  const baseTag = `<base href="${escapeHtml(`${baseUrl}/abs${dir}/`)}">`;
  const hashFix = `<script>(function(){document.addEventListener("click",function(e){var a=e.target.closest("a[href^='#']");if(!a)return;e.preventDefault();var h=a.getAttribute("href");var id=h.slice(1);if(id){var el=document.getElementById(id)||document.querySelector("[name='"+id+"']");if(el){el.scrollIntoView({behavior:"smooth",block:"start"});history.replaceState(null,"",h);return;}}window.location.hash=h;});})();</script>`;
  const injection = `${baseTag}\n  ${hashFix}`;
  if (/<head(\s[^>]*)?>/i.test(html)) return html.replace(/(<head(\s[^>]*)?>)/i, `$1\n  ${injection}`);
  if (/<html(\s[^>]*)?>/i.test(html)) return html.replace(/(<html(\s[^>]*)?>)/i, `$1\n${injection}`);
  return `${injection}\n${html}`;
}

async function serveFile(fs, absPath, baseUrl, inject) {
  let st;
  try { st = await fs.stat(absPath); } catch { return text(`Not found: ${absPath}`, 404); }
  if (st.isDirectory) {
    for (const name of ["index.html", "index.htm"]) {
      const idx = `${absPath}/${name}`;
      if (await fs.exists(idx)) return serveFile(fs, idx, baseUrl, true);
    }
    return text(`Directory listing not supported. No index.html found in ${absPath}`, 404);
  }
  let bytes;
  try { bytes = await fs.readFileBuffer(absPath); } catch (e) { return text(`Read error: ${e?.message ?? e}`, 500); }
  const binary = isLikelyBinary(bytes, absPath);
  let mime = mimeTypeFor(absPath, binary);
  if (!binary && !/charset/.test(mime) && /^text\/|json|xml|javascript/.test(mime)) mime += "; charset=utf-8";
  if (inject && isHtml(absPath)) {
    return new Response(injectBase(new TextDecoder().decode(bytes), absPath, baseUrl), { headers: { "Content-Type": mime, ...CORS } });
  }
  return new Response(bytes, { headers: { "Content-Type": mime, "Content-Length": String(bytes.length), ...CORS } });
}

/**
 * Answer a request under STATIC_PREFIX, or null. `path` is the route with the
 * session prefix already stripped.
 */
export async function staticAnswer(req, path, url, cell) {
  if (path !== STATIC_PREFIX && !path.startsWith(STATIC_PREFIX + "/")) return null;
  const sub = path.slice(STATIC_PREFIX.length) || "/";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET" && req.method !== "HEAD") return text("Method not allowed", 405);
  await cell.ready;
  const baseUrl = publicBaseUrl(req, url);
  if (sub === "/health") {
    return new Response(JSON.stringify({ status: "ok", port: 3211, cell: true }), { headers: { "Content-Type": "application/json", ...CORS } });
  }
  if (sub === "/" || sub === "/index.html") {
    return new Response(`<!doctype html><meta charset="utf-8"><title>Cell static files</title><p>Open a file: <code>${escapeHtml(baseUrl)}/open?path=/workspace/index.html</code></p><p>Allowed roots: ${STATIC_ROOTS.map((r) => `<code>${escapeHtml(r)}</code>`).join(", ")}</p>`, { headers: { "Content-Type": "text/html; charset=utf-8", ...CORS } });
  }
  if (sub === "/open") {
    const abs = toAbsPath(url.searchParams.get("path") || "");
    if (!abs) return text("Missing or invalid ?path=/absolute/file", 400);
    return serveFile(cell.fs, abs, baseUrl, true);
  }
  if (sub.startsWith("/abs/")) {
    let raw;
    try { raw = "/" + decodeURIComponent(sub.slice("/abs/".length)); } catch { return text("Invalid absolute path", 400); }
    const abs = toAbsPath(raw);
    if (!abs) return text("Invalid absolute path", 400);
    return serveFile(cell.fs, abs, baseUrl, false);
  }
  return text("Not found", 404);
}
