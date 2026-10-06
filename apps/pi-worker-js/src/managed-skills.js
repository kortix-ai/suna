// THE MANAGED `kortix-*` SKILLS, IN A CELL.
//
// A VM session reads the platform's managed skill overlay from
// `/opt/kortix/managed-skills`: baked into the image, then refreshed from
// `GET /v1/runtime-assets/managed-skills` after boot (apps/api
// runtime-assets/managed-skills.ts). kortixd's pi harness lists that directory
// FIRST, so the platform's copy of a `kortix-*` skill wins over the one a
// project tracks. A cell has no image, so it had no managed skills at all.
//
// The overlay (~300 KB) is kept in the cell's SQLite, keyed by its hash, and
// written into the in-memory tree at the same path the VM uses. The tree under
// /opt is not persisted (execenv.cell.js persists /workspace and /tmp only), so
// a new isolate re-materialises from SQLite without a network round trip, and
// the fetch carries `If-None-Match` so an unchanged overlay costs a 304.
import { MANAGED_SKILLS_DIR } from "./skills.js";

export const MANAGED_SKILLS_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS managed_skills (k TEXT PRIMARY KEY, hash TEXT NOT NULL, files TEXT NOT NULL, fetched_at INTEGER NOT NULL)";

/** How long a fetched overlay is trusted before the next conditional fetch. */
export const MANAGED_SKILLS_TTL_MS = 10 * 60_000;
/** The longest a fetch may take; a slow API must not hold a prompt. */
export const MANAGED_SKILLS_FETCH_MS = 4_000;

/** `${KORTIX_API_URL}/runtime-assets/managed-skills`, or null without an API URL and token. */
export function managedSkillsUrl(env) {
  const api = String(env?.KORTIX_API_URL ?? "").trim().replace(/\/+$/, "");
  const token = String(env?.KORTIX_TOKEN ?? "").trim();
  return api && token ? `${api}/runtime-assets/managed-skills` : null;
}

/** The overlay this cell holds, or null. */
export function storedOverlay(sql) {
  const row = sql.exec("SELECT hash, files, fetched_at FROM managed_skills WHERE k = 'overlay'").toArray()[0];
  if (!row) return null;
  try { return { hash: String(row.hash), files: JSON.parse(String(row.files)), fetchedAt: Number(row.fetched_at) }; } catch { return null; }
}

export function storeOverlay(sql, overlay, now = Date.now()) {
  sql.exec(
    "INSERT INTO managed_skills(k, hash, files, fetched_at) VALUES ('overlay', ?, ?, ?) ON CONFLICT(k) DO UPDATE SET hash = excluded.hash, files = excluded.files, fetched_at = excluded.fetched_at",
    overlay.hash, JSON.stringify(overlay.files), now,
  );
}

export function touchOverlay(sql, now = Date.now()) {
  sql.exec("UPDATE managed_skills SET fetched_at = ? WHERE k = 'overlay'", now);
}

/** A relative overlay path, or null: no absolute path, no `..`, no empty segment. */
export function safeOverlayPath(path) {
  if (typeof path !== "string" || !path || path.startsWith("/")) return null;
  return path.split("/").every((s) => s && s !== "." && s !== "..") ? path : null;
}

/**
 * One conditional fetch. `{ status: "same" }` on 304, `{ status: "new", hash, files }`
 * on 200, `{ status: "error", error }` otherwise. Never throws.
 */
export async function fetchOverlay({ env, etag = null, fetchImpl = fetch, timeoutMs = MANAGED_SKILLS_FETCH_MS }) {
  const url = managedSkillsUrl(env);
  if (!url) return { status: "error", error: "no KORTIX_API_URL or KORTIX_TOKEN" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${String(env.KORTIX_TOKEN).trim()}`, ...(etag ? { "if-none-match": `"${etag}"` } : {}) },
      signal: ctl.signal,
    });
    if (res.status === 304) return { status: "same" };
    if (res.status !== 200) return { status: "error", error: `managed skills: HTTP ${res.status}` };
    const body = await res.json();
    if (!body || typeof body.hash !== "string" || !Array.isArray(body.files)) return { status: "error", error: "managed skills: malformed overlay" };
    const files = body.files
      .filter((f) => f && safeOverlayPath(f.path) && typeof f.content === "string")
      .map((f) => ({ path: f.path, content: f.content }));
    return { status: "new", hash: body.hash, files };
  } catch (e) {
    return { status: "error", error: `managed skills: ${ctl.signal.aborted ? `timed out after ${timeoutMs} ms` : String(e?.message ?? e)}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Write the overlay into the tree at MANAGED_SKILLS_DIR, replacing whatever
 * was there, unless the tree already carries this hash.
 * `fs` is the cell's just-bash filesystem. Returns whether it wrote.
 */
export async function materializeOverlay(fs, overlay) {
  const marker = `${MANAGED_SKILLS_DIR}/.overlay-hash`;
  const current = await fs.readFile(marker, "utf8").catch(() => null);
  if (current === overlay.hash) return false;
  await fs.rm(MANAGED_SKILLS_DIR, { recursive: true, force: true }).catch(() => {});
  for (const file of overlay.files) {
    const rel = safeOverlayPath(file.path);
    if (!rel) continue;
    const path = `${MANAGED_SKILLS_DIR}/${rel}`;
    await fs.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await fs.writeFile(path, file.content);
  }
  await fs.writeFile(marker, overlay.hash);
  return true;
}
