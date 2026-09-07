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
import { ExecutionError, FileError, err, ok } from "@earendil-works/pi-agent-core";

export const CELL_CWD = "/work";
const fail = (message, path, code = "unknown") => err(new FileError(code, String(message), path));
const codeOf = (e) => /ENOENT|not found|no such/i.test(e?.message ?? "") ? "not_found" : /EISDIR|is a directory/i.test(e?.message ?? "") ? "is_directory" : /EEXIST/i.test(e?.message ?? "") ? "exists" : "unknown";
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** One per cell instance: the tree restored from SQLite, and a shell over it. */
export function cellFs(sql) {
  sql.exec("CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, dir INTEGER NOT NULL, mode INTEGER, mtime INTEGER, body TEXT)");
  const fs = new InMemoryFs();
  const restored = { dirs: 0, files: 0 };
  const boot = (async () => {
    await fs.mkdir(CELL_CWD, { recursive: true });
    for (const r of [...sql.exec("SELECT path, dir, mode, body FROM files ORDER BY path")]) {
      if (r.dir) { await fs.mkdir(r.path, { recursive: true }); restored.dirs++; }
      else { await fs.mkdir(r.path.slice(0, r.path.lastIndexOf("/")) || "/", { recursive: true }); await fs.writeFile(r.path, unb64(r.body ?? "")); restored.files++; }
    }
  })();
  const bash = new Bash({ fs, cwd: CELL_CWD, env: { HOME: CELL_CWD, PWD: CELL_CWD } });
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
  return { fs, bash, persist, ready: boot, restored };
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
  "git", "curl", "wget", "ssh", "node", "npm", "pnpm", "yarn", "python", "python3",
  "pip", "docker", "make", "gcc", "apt-get", "tar", "uname",
];

export function cellShellNote() {
  return [
    "Your bash tool runs a POSIX shell over this session's own virtual filesystem.",
    "It is NOT a Linux machine: there is no network, no package manager, and no language runtime.",
    `These do not exist — never call them and never propose a plan that needs them: ${CELL_MISSING.join(", ")}.`,
    "",
    `The ${CELL_COMMANDS.length} commands you DO have: ${CELL_COMMANDS.join(", ")}.`,
    "",
    `Your working directory is ${CELL_CWD}, and it persists between turns: a file you write now is`,
    "still there in the next message. Use the write and read tools for file contents, grep/rg/find to",
    "search, and awk/sed/jq to transform. To run a program, write the logic as a shell script — you",
    "cannot execute Python or JavaScript here.",
  ].join("\n");
}

export function cellExecutionEnv(cell, cwd = CELL_CWD) {
  const { fs, bash, persist, ready } = cell;
  const abs = (p) => (p.startsWith("/") ? p : `${cwd}/${p}`).replace(/\/+/g, "/");
  const mutate = async (fn) => { await ready; const r = await fn(); await persist(); return r; };
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
        const r = await bash.exec(command, { cwd: options.cwd ?? cwd, env: options.env, signal: ctl.signal });
        // just-bash does not throw on abort: it returns exit 124 with
        // "bash: execution aborted" on stderr. Read the signal, not the shape,
        // or a timed-out command reports as a successful run that exited 124.
        if (ctl.signal.aborted) return err(new ExecutionError("timeout", `timeout:${seconds}`));
        if (r.stdout && options.onStdout) options.onStdout(r.stdout);
        if (r.stderr && options.onStderr) options.onStderr(r.stderr);
        await persist();
        return ok({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode });
      } catch (e) {
        if (ctl.signal.aborted) return err(new ExecutionError("timeout", `timeout:${seconds}`));
        return err(new ExecutionError("failed", String(e?.message ?? e)));
      } finally { clearTimeout(timer); }
    },
  };
}
