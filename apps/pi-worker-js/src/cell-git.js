// THE PROJECT'S FILES, IN THE CELL.
//
// A cell's workspace started empty and stayed empty: `KORTIX_PROJECT_AUTO_CLONE`
// is `0` for a pi worker and nothing else ever put a file there. Everything
// downstream of a checkout was therefore missing at once — the Files panel had
// nothing to show, `.kortix/opencode/skills` could not be read, AGENTS.md did
// not exist, `/file/status` answered `[]` because there was no git, and the
// agent could only work on files it had written itself.
//
// Kortix already serves every project over smart HTTP at
// `<api>/v1/git/<projectId>.git`, authenticated with the session's own token
// (apps/api/src/git-proxy: a session-scoped credential is an agent credential),
// so the cell needs no host credential and no new authority — the same token it
// already holds for the model gateway.
//
// isomorphic-git does the protocol; this module is the two adapters it needs
// (a promise-fs over the cell's in-memory tree, and an http client over the
// guarded fetch) plus the small decisions: shallow, single-branch, one clone at
// a time, and a size the isolate can hold.

import gitCore from "isomorphic-git";
import { CELL_CWD } from "./execenv.cell.js";
import { guardedFetch } from "./cell-net.js";

export const git = gitCore;

/** A shallow clone: history is not what an agent session needs, and it is most of the bytes. */
export const CLONE_DEPTH = 1;
/** Bail out rather than fill the isolate: a repo past this is a checkout the cell cannot hold. */
export const MAX_CLONE_BYTES = 64 * 1024 * 1024;

/**
 * The promise-fs isomorphic-git asks for, over just-bash's InMemoryFs.
 *
 * Three shapes have to be exact or the clone fails in ways that read as
 * corruption: `readFile` answers a Uint8Array unless an encoding is named,
 * `readdir`/`stat` throw ENOENT-shaped errors (isomorphic-git tests
 * `err.code === 'ENOENT'` constantly, and a plain Error means "the repo is
 * broken" instead of "the file is not there"), and `stat` carries the mode
 * bits and an `isFile()`/`isDirectory()` pair rather than the booleans this
 * filesystem returns.
 */
/** The bytes a caller means, whatever container they arrived in. */
export function toBytes(data) {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  return new Uint8Array(data ?? []);
}

export function gitFs(fs) {
  const enoent = (path) => { const e = new Error(`ENOENT: no such file or directory, '${path}'`); e.code = "ENOENT"; e.errno = -2; e.path = path; return e; };
  const eexist = (path) => { const e = new Error(`EEXIST: file already exists, '${path}'`); e.code = "EEXIST"; e.errno = -17; e.path = path; return e; };
  const missing = (e) => /ENOENT|not found|no such|does not exist/i.test(e?.message ?? "");
  const statLike = (st, path) => ({
    type: st.isDirectory ? "dir" : st.isSymbolicLink ? "symlink" : "file",
    mode: st.mode ?? (st.isDirectory ? 0o040755 : 0o100644),
    size: st.size ?? 0,
    ino: 0, uid: 1, gid: 1, dev: 1,
    mtimeMs: +st.mtime || 0, ctimeMs: +st.mtime || 0,
    isFile: () => !st.isDirectory && !st.isSymbolicLink,
    isDirectory: () => !!st.isDirectory,
    isSymbolicLink: () => !!st.isSymbolicLink,
    path,
  });
  return {
    promises: {
      async readFile(path, options) {
        const encoding = typeof options === "string" ? options : options?.encoding;
        try {
          return encoding ? await fs.readFile(path, encoding) : await fs.readFileBuffer(path);
        } catch (e) { throw missing(e) ? enoent(path) : e; }
      },
      async writeFile(path, data) {
        const dir = path.slice(0, path.lastIndexOf("/")) || "/";
        await fs.mkdir(dir, { recursive: true });
        // A VIEW IS NOT ITS BUFFER. `new Uint8Array(data.buffer)` takes the
        // whole underlying ArrayBuffer from offset 0 — for a Buffer sliced out
        // of a pool that is somebody else's bytes, at the wrong length. It
        // wrote a git index whose magic read `/\0\0\0` instead of `DIRC` and
        // every commit failed with "Invalid dircache magic file number"
        // (2026-09-10). Copy the VIEW.
        await fs.writeFile(path, typeof data === "string" ? data : toBytes(data));
      },
      async unlink(path) { try { await fs.rm(path, { force: true }); } catch (e) { throw missing(e) ? enoent(path) : e; } },
      async readdir(path) { try { return await fs.readdir(path); } catch (e) { throw missing(e) ? enoent(path) : e; } },
      async mkdir(path, options) {
        if (options?.recursive) return fs.mkdir(path, { recursive: true });
        if (await fs.exists(path)) throw eexist(path);
        return fs.mkdir(path, { recursive: true });
      },
      async rmdir(path) { try { await fs.rm(path, { recursive: true, force: true }); } catch (e) { throw missing(e) ? enoent(path) : e; } },
      async stat(path) { try { return statLike(await fs.stat(path), path); } catch (e) { throw missing(e) ? enoent(path) : e; } },
      async lstat(path) { try { return statLike(await fs.lstat(path), path); } catch (e) { throw missing(e) ? enoent(path) : e; } },
      async readlink(path) { try { return await fs.readlink(path); } catch (e) { throw missing(e) ? enoent(path) : e; } },
      async symlink(target, path) { return fs.symlink(target, path); },
      async chmod(path, mode) { try { return await fs.chmod(path, mode); } catch { /* the tree keeps no modes it can enforce */ } },
    },
  };
}

/**
 * isomorphic-git's http client over the cell's guarded fetch.
 *
 * Written here rather than imported from `isomorphic-git/http/web` for one
 * reason: that client calls the global `fetch`, and the cell's rule is that
 * every outbound request goes through the guard (cell-net.js). The body is a
 * byte-stream iterator both ways, which is the whole interface.
 */
export function gitHttp(fetchImpl = globalThis.fetch) {
  return {
    async request({ url, method = "GET", headers = {}, body }) {
      let payload;
      if (body) {
        const chunks = [];
        for await (const chunk of body) chunks.push(chunk);
        const parts = chunks.map(toBytes);
        let size = 0;
        for (const c of parts) size += c.length;
        payload = new Uint8Array(size);
        let at = 0;
        for (const c of parts) { payload.set(c, at); at += c.length; }
      }
      const res = await fetchImpl(url, { method, headers, body: payload, redirect: "follow" });
      const bytes = new Uint8Array(await res.arrayBuffer());
      const out = {};
      res.headers?.forEach?.((v, k) => { out[k.toLowerCase()] = v; });
      return {
        url: res.url ?? url,
        method,
        statusCode: res.status,
        statusMessage: res.statusText,
        headers: out,
        body: [bytes],
      };
    },
  };
}

/** `<api>/v1/git/<projectId>.git` — the origin every Kortix client clones from. */
export function projectGitUrl(apiUrl, projectId) {
  const base = String(apiUrl ?? "").replace(/\/+$/, "");
  const id = String(projectId ?? "").trim();
  if (!base || !id) return null;
  return `${base.endsWith("/v1") ? base : `${base}/v1`}/git/${id}.git`;
}

/**
 * The credential the git proxy takes: the session's own Kortix token, as
 * HTTP basic — the shape `git` itself sends, and what `extractToken` reads
 * (apps/api/src/git-proxy/parse.ts).
 */
export const gitAuth = (token) => (token ? { username: "x-access-token", password: token } : {});

/** Has this workspace been checked out already? */
export async function isCheckedOut(fs, dir = CELL_CWD) {
  try { return await fs.exists(`${dir}/.git/HEAD`); } catch { return false; }
}

/**
 * Clone the project into the workspace. One at a time per cell (`inFlight`),
 * because two clones into one tree is a corrupted tree; already-cloned is a
 * no-op, so this is safe to call on every turn.
 */
export async function cloneProject(input) {
  const { cell, url, ref, token, onProgress, fetchImpl } = input;
  const dir = input.dir ?? CELL_CWD;
  if (!url) return { ok: false, reason: "no repo url" };
  if (await isCheckedOut(cell.fs, dir)) return { ok: true, reason: "already checked out", cloned: false };
  if (cell.__cloning) return cell.__cloning;
  const run = (async () => {
    const started = Date.now();
    try {
      await git.clone({
        fs: gitFs(cell.fs),
        http: gitHttp(fetchImpl ?? guardedFetchForGit()),
        dir,
        url,
        ref: ref || undefined,
        singleBranch: true,
        depth: CLONE_DEPTH,
        noTags: true,
        onAuth: () => gitAuth(token),
        onProgress: onProgress ? (p) => onProgress(p) : undefined,
      });
      await cell.persist?.();
      const files = await git.listFiles({ fs: gitFs(cell.fs), dir }).catch(() => []);
      return { ok: true, cloned: true, files: files.length, ms: Date.now() - started };
    } catch (e) {
      return { ok: false, reason: String(e?.message ?? e), ms: Date.now() - started };
    } finally {
      cell.__cloning = null;
    }
  })();
  cell.__cloning = run;
  return run;
}

/** A fetch for git: the guard, with redirects followed and a larger body cap than a page. */
function guardedFetchForGit() {
  const secure = guardedFetch(globalThis.fetch, { maxBody: MAX_CLONE_BYTES, timeoutMs: 120_000 });
  return async (url, init = {}) => {
    const r = await secure(url, {
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body,
      followRedirects: true,
      timeoutMs: 120_000,
    });
    return new Response(r.body, { status: r.status, statusText: r.statusText, headers: r.headers });
  };
}

/**
 * `/file/status` for a checked-out workspace: what changed since HEAD, in the
 * daemon's shape (path, added, removed, status).
 *
 * WALKED, NOT `statusMatrix`. That helper trusts the index's cached stat data,
 * and this filesystem writes whole files in milliseconds — two writes inside
 * one second are indistinguishable at git's one-second stat granularity, so a
 * file edited right after it was committed reported UNCHANGED (measured
 * 2026-09-10: `tracked.txt` went from `one` to `two`, same length, and the
 * matrix said `[1,1,1]`). Walking HEAD against the working tree compares
 * object ids, which cannot be fooled by a clock.
 *
 * Line counts are not free from a walk, so they are 0 — the panel shows the
 * file and its state, which is what a session needs.
 */
export async function workingStatus(cell, dir = CELL_CWD) {
  if (!(await isCheckedOut(cell.fs, dir))) return [];
  const fs = gitFs(cell.fs);
  try {
    // HEAD's blobs, by path. A walk over ONE tree is reliable; the combined
    // `[TREE, WORKDIR]` walk answered an empty list here while either walker
    // alone answered correctly (measured 2026-09-10), and `statusMatrix`
    // trusts a one-second stat granularity this filesystem writes inside
    // (see the note above). Two passes and a hash cannot be fooled by either.
    const head = new Map();
    await git.walk({
      fs, dir, trees: [git.TREE({ ref: "HEAD" })],
      map: async (filepath, [entry]) => {
        if (filepath === "." || !entry) return undefined;
        if ((await entry.type()) === "tree") return undefined;
        head.set(filepath, await entry.oid());
        return null;
      },
    });
    const out = [];
    const seen = new Set();
    for (const filepath of await walkWorkdir(cell.fs, dir)) {
      seen.add(filepath);
      const bytes = await cell.fs.readFileBuffer(`${dir}/${filepath}`).catch(() => null);
      if (!bytes) continue;
      const oid = await git.hashBlob({ object: toBytes(bytes) }).then((r) => r.oid);
      const known = head.get(filepath);
      if (known === undefined) {
        const ignored = await git.isIgnored({ fs, dir, filepath }).catch(() => false);
        if (!ignored) out.push({ path: filepath, added: 0, removed: 0, status: "added" });
      } else if (known !== oid) {
        out.push({ path: filepath, added: 0, removed: 0, status: "modified" });
      }
    }
    for (const filepath of head.keys()) {
      if (!seen.has(filepath)) out.push({ path: filepath, added: 0, removed: 0, status: "deleted" });
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  } catch {
    return [];
  }
}

/** Every file in the workspace, workspace-relative, `.git` skipped. */
async function walkWorkdir(fs, dir) {
  const out = [];
  async function walk(prefix) {
    let entries;
    try { entries = await fs.readdirWithFileTypes(prefix ? `${dir}/${prefix}` : dir); } catch { return; }
    for (const e of entries) {
      const next = prefix ? `${prefix}/${e.name}` : e.name;
      if (next === ".git" || next.startsWith(".git/")) continue;
      if (e.isDirectory) await walk(next);
      else if (e.isFile) out.push(next);
    }
  }
  await walk("");
  return out;
}
