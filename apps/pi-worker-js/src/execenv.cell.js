// THE FILESYSTEM AND SHELL A CELL CARRIES ITSELF, so an agent that only ever
// runs `ls`, `cat`, `grep`, `sed` and small scripts needs no microVM at all.
//
// Until this existed a session had two costs: the cell (~2 MiB) and a
// workspace microVM (512 MB–2 GB) the tools executed in. For most turns the
// second is paid for `cat`. just-bash is a bash interpreter in pure TypeScript
// with a virtual filesystem and 70+ coreutils; its browser build has no Node
// imports, no native code and no runtime codegen — which is the exact list an
// isolate refuses — so it bundles into the worker like any other module.
//
// The tree lives in the cell's own SQLite, so it goes to object storage with
// the transcript, survives eviction, and moves with the cell between nodes. A
// full snapshot after every mutation is deliberately simple: the commit is one
// durable write either way, and an agent workspace is small. Heavy work —
// compiling, docker, GPUs — still escalates to a real sandbox; that is the same
// line agentOS draws, from the other side.
import { Bash, InMemoryFs } from "just-bash/browser";
import { guardedFetch, wgetCommand } from "./cell-net.js";
import { ExecutionError, FileError, err, ok } from "@earendil-works/pi-agent-core";

// THE WORKSPACE IS /workspace — the path the Kortix client addresses. The SDK
// anchors every host path under it (packages/sdk core/files/client.ts) and
// the daemon serves it, so a cell whose tree lived at /work had files the
// Files panel could not name. A tree stored under the old root is moved on
// restore; see cellFs().
export const CELL_CWD = "/workspace";
const LEGACY_CWD = "/work";
const fail = (message, path, code = "unknown") => err(new FileError(code, String(message), path));
const codeOf = (e) => /ENOENT|not found|no such/i.test(e?.message ?? "") ? "not_found" : /EISDIR|is a directory/i.test(e?.message ?? "") ? "is_directory" : /EEXIST/i.test(e?.message ?? "") ? "exists" : "unknown";
// CHUNKED, because a spread is an argument list. `String.fromCharCode(...u8)`
// is fine for a note the agent typed and dies on a git packfile: cloning a
// project into a cell hit "Maximum call stack size exceeded" in persist()
// before a single file reached storage (2026-09-10).
const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** One per cell instance: the tree restored from SQLite, and a shell over it. */
export function cellFs(sql) {
  sql.exec("CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, dir INTEGER NOT NULL, mode INTEGER, mtime INTEGER, body TEXT)");
  const fs = new InMemoryFs();
  const restored = { dirs: 0, files: 0 };
  const boot = (async () => {
    await fs.mkdir(CELL_CWD, { recursive: true });
    for (const r of [...sql.exec("SELECT path, dir, mode, body FROM files ORDER BY path")]) {
      // A row from before the move: the same file, under the workspace root.
      // The old rows go at the next persist (not in the tree → deleted).
      const path = r.path === LEGACY_CWD ? CELL_CWD : r.path.startsWith(LEGACY_CWD + "/") ? CELL_CWD + r.path.slice(LEGACY_CWD.length) : r.path;
      if (r.dir) { await fs.mkdir(path, { recursive: true }); restored.dirs++; }
      else { await fs.mkdir(path.slice(0, path.lastIndexOf("/")) || "/", { recursive: true }); await fs.writeFile(path, unb64(r.body ?? "")); restored.files++; }
    }
  })();
  // Network: curl (just-bash's own, registered by the fetch) and wget, over
  // the guarded fetch in cell-net.js. The shell's env carries no credential,
  // so what the model can reach it reaches as an anonymous client.
  const net = guardedFetch();
  const bash = new Bash({ fs, cwd: CELL_CWD, env: { HOME: CELL_CWD, PWD: CELL_CWD }, fetch: net, customCommands: [wgetCommand(net)] });
  // Snapshot the whole tree. Rows not in the tree are gone; everything else is
  // upserted. One statement each, inside the one commit the request already pays.
  async function persist() {
    // ONLY THE AGENT'S OWN TREE. just-bash ships a skeleton — /bin, /usr, /etc
    // and friends, 181 paths on an empty cell — and snapshotting that on every
    // write is 181 rows of base64 per commit for files nobody wrote. What is
    // durable is what the agent made: /work and /tmp.
    const paths = fs.getAllPaths().filter((p) => p.startsWith(CELL_CWD + "/") || p === CELL_CWD || p.startsWith("/tmp/"));
    const seen = new Set(paths);
    for (const r of [...sql.exec("SELECT path FROM files")]) if (!seen.has(r.path)) sql.exec("DELETE FROM files WHERE path = ?", r.path);
    for (const p of paths) {
      const st = await fs.stat(p);
      const body = st.isDirectory ? null : b64(await fs.readFileBuffer(p));
      sql.exec("INSERT INTO files(path, dir, mode, mtime, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET dir=excluded.dir, mode=excluded.mode, mtime=excluded.mtime, body=excluded.body",
        p, st.isDirectory ? 1 : 0, st.mode ?? 0o644, Math.floor(+st.mtime || Date.now()), body);
    }
  }
  // WHAT CHANGED, for whoever paints the tree. The Files panel re-reads its
  // list on a `file.edited` frame (packages/sdk react handle-event.ts) and
  // otherwise shows what it read when it opened — measured 2026-09-10: a file
  // the agent wrote while the panel was open did not appear until the panel
  // was closed and reopened. A snapshot (path → size:mtime) before and after
  // a mutation names the paths that differ; the worker publishes them.
  const cell = { fs, bash, persist, ready: boot, restored, onChange: null };
  cell.snapshot = async () => {
    const out = new Map();
    for (const p of fs.getAllPaths().filter((p) => p.startsWith(CELL_CWD + "/") || p.startsWith("/tmp/"))) {
      try { const st = await fs.stat(p); out.set(p, st.isDirectory ? "d" : `${st.size}:${+st.mtime || 0}`); } catch { /* raced away */ }
    }
    return out;
  };
  cell.changedSince = (before, after) => {
    const changed = [];
    for (const [p, v] of after) if (before.get(p) !== v) changed.push(p);
    for (const p of before.keys()) if (!after.has(p)) changed.push(p);
    return changed;
  };
  cell.notify = (paths) => { if (paths.length && typeof cell.onChange === "function") { try { cell.onChange(paths); } catch { /* a listener must not break a write */ } } };
  return cell;
}

/** pi's ExecutionEnv over the cell's own tree. Same shapes as the Platinum backend. */
// WHAT THE SHELL ACTUALLY IS, in the agent's own system prompt.
//
// The cell's bash is just-bash: a bash interpreter over a virtual filesystem,
// not a Linux box. Told nothing, a model reaches for the tools every coding
// agent has always had and gets `command not found` with no idea what to try
// instead — measured 2026-09-07: git, curl, node, npm, pip, python3, docker,
// apt-get and uname all exit 127, and python3's message even names the
// interpreter's own host ("not available in browser environments"), which is
// both confusing and an implementation detail the model should never see.
//
// A LIST, NOT A LOOKUP: `/usr/bin` is synthesised by the shell rather than
// present in the filesystem (`readdir` there is ENOENT), and the note has to
// be built synchronously while the agent is constructed. So it is written
// down — and cellfs-logic asserts this array equals what `ls /usr/bin` really
// prints, so a just-bash upgrade that adds or drops a command fails the suite
// instead of quietly leaving the prompt lying to the model.
export const CELL_COMMANDS = ["alias", "awk", "base64", "basename", "bash", "cat", "chmod", "clear", "column", "comm", "cp", "cut", "date", "diff", "dirname", "du", "echo", "egrep", "env", "expand", "expr", "false", "fgrep", "file", "find", "fold", "grep", "gunzip", "gzip", "head", "help", "history", "hostname", "html-to-markdown", "join", "jq", "ln", "ls", "md5sum", "mkdir", "mv", "nl", "od", "paste", "printenv", "printf", "pwd", "readlink", "rev", "rg", "rm", "rmdir", "sed", "seq", "sh", "sha1sum", "sha256sum", "sleep", "sort", "split", "stat", "strings", "tac", "tail", "tee", "time", "timeout", "touch", "tr", "tree", "true", "unalias", "unexpand", "uniq", "wc", "which", "whoami", "xargs", "zcat"];

/** The commands a real box has that this shell does not — named, because a
 *  model that is not told will try them and burn a turn on exit 127. */
export const CELL_MISSING = [
  "git", "ssh", "node", "npm", "pnpm", "yarn", "python", "python3",
  "pip", "docker", "make", "gcc", "apt-get", "tar", "uname",
];

/** Network commands, present since 2026-09-10 — named apart because the list
 *  claim compares `ls /usr/bin`, where a fetch-registered command may not show. */
export const CELL_NET_COMMANDS = ["curl", "wget"];

// WHAT THE MODEL IS TOLD ABOUT ITS SHELL. Two facts, not an inventory: the
// note used to list every command the shell has and every one it lacks, which
// spent 900 characters of every prompt teaching the model a catalogue it
// could discover with one `ls`, and still left it with nowhere to go when the
// task needed a real machine. Now it knows it is restricted and it knows the
// way out.
export function cellShellNote() {
  return [
    `Your bash tool is a small POSIX shell over this session's own tree at ${CELL_CWD}, which persists between turns.`,
    "It is not a Linux machine: no language runtimes, no package manager, no processes. curl and wget work over HTTP(S).",
    "When a task needs a real machine — node, python, package installs, builds, a dev server, git — use the machine tool: it attaches a full Linux environment with the project checked out, and runs your command there.",
  ].join("\n");
}

export function cellExecutionEnv(cell, cwd = CELL_CWD) {
  const { fs, bash, persist, ready } = cell;
  const abs = (p) => (p.startsWith("/") ? p : `${cwd}/${p}`).replace(/\/+/g, "/");
  const mutate = async (fn) => { await ready; const before = await cell.snapshot(); const r = await fn(); await persist(); cell.notify(cell.changedSince(before, await cell.snapshot())); return r; };
  const stat = async (p) => { const s = await fs.stat(abs(p)); return { name: abs(p).split("/").pop(), path: abs(p), kind: s.isDirectory ? "directory" : "file", size: s.size ?? 0, mtimeMs: +s.mtime || 0 }; };
  return {
    cwd, idempotent: true,
    async absolutePath(p) { return ok(abs(p)); },
    async joinPath(parts) { return ok(parts.filter(Boolean).join("/").replace(/\/+/g, "/")); },
    async canonicalPath(p) { return ok(abs(p)); },
    async readTextFile(p) { await ready; try { return ok(await fs.readFile(abs(p), "utf8")); } catch (e) { return fail(e.message, p, codeOf(e)); } },
    async readTextLines(p, options = {}) { await ready; try { const lines = (await fs.readFile(abs(p), "utf8")).split("\n"); return ok(options.maxLines !== undefined ? lines.slice(0, options.maxLines) : lines); } catch (e) { return fail(e.message, p, codeOf(e)); } },
    async readBinaryFile(p) { await ready; try { return ok(await fs.readFileBuffer(abs(p))); } catch (e) { return fail(e.message, p, codeOf(e)); } },
    async writeFile(p, content) { try { return await mutate(async () => { await fs.mkdir(abs(p).slice(0, abs(p).lastIndexOf("/")) || "/", { recursive: true }); await fs.writeFile(abs(p), content); return ok(undefined); }); } catch (e) { return fail(e.message, p, codeOf(e)); } },
    async appendFile(p, content) { try { return await mutate(async () => { await fs.appendFile(abs(p), content); return ok(undefined); }); } catch (e) { return fail(e.message, p, codeOf(e)); } },
    async renameFile(a, b) { try { return await mutate(async () => { await fs.mv(abs(a), abs(b)); return ok(undefined); }); } catch (e) { return fail(e.message, a, codeOf(e)); } },
    async fileInfo(p) { await ready; try { return ok(await stat(p)); } catch (e) { return fail(e.message, p, codeOf(e)); } },
    async listDir(p) { await ready; try { const d = abs(p); const names = await fs.readdir(d); return ok(await Promise.all(names.map((n) => stat(`${d}/${n}`)))); } catch (e) { return fail(e.message, p, codeOf(e)); } },
    async exists(p) { await ready; return ok(await fs.exists(abs(p))); },
    async createDir(p, options = {}) { try { return await mutate(async () => { await fs.mkdir(abs(p), { recursive: options.recursive !== false }); return ok(undefined); }); } catch (e) { return fail(e.message, p, codeOf(e)); } },
    async remove(p, options = {}) { try { return await mutate(async () => { await fs.rm(abs(p), { recursive: options.recursive !== false, force: true }); return ok(undefined); }); } catch (e) { return fail(e.message, p, codeOf(e)); } },
    async createTempDir(prefix = "tmp") { const d = `/tmp/${prefix}-${Date.now().toString(36)}`; return this.createDir(d).then((r) => (r.ok ? ok(d) : r)); },
    async createTempFile(prefix = "tmp", ext = "") { const f = `/tmp/${prefix}-${Date.now().toString(36)}${ext}`; return this.writeFile(f, "").then((r) => (r.ok ? ok(f) : r)); },
    async cleanup() { return ok(undefined); },
    async exec(command, options = {}) {
      await ready;
      const seconds = options.timeout ?? 120;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), seconds * 1000);
      try {
        const before = await cell.snapshot();
        const r = await bash.exec(command, { cwd: options.cwd ?? cwd, env: options.env, signal: ctl.signal });
        // just-bash does not throw on abort: it returns exit 124 with
        // "bash: execution aborted" on stderr. Read the signal, not the shape,
        // or a timed-out command reports as a successful run that exited 124.
        if (ctl.signal.aborted) return err(new ExecutionError("timeout", `timeout:${seconds}`));
        if (r.stdout && options.onStdout) options.onStdout(r.stdout);
        if (r.stderr && options.onStderr) options.onStderr(r.stderr);
        await persist();
        cell.notify(cell.changedSince(before, await cell.snapshot()));
        return ok({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode });
      } catch (e) {
        if (ctl.signal.aborted) return err(new ExecutionError("timeout", `timeout:${seconds}`));
        return err(new ExecutionError("failed", String(e?.message ?? e)));
      } finally { clearTimeout(timer); }
    },
  };
}
