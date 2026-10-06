// THE FILESYSTEM AND SHELL A CELL CARRIES ITSELF, so an agent that only ever
// runs `ls`, `cat`, `grep`, `sed` and small scripts needs no microVM at all.
//
// just-bash is a bash interpreter in pure TypeScript with a virtual filesystem
// and 70+ coreutils. Its browser build has no native code and no runtime
// codegen, so it bundles into the worker like any other module. It does import
// `node:zlib` (gzip), which is why wrangler.json carries `nodejs_compat`.
//
// The tree lives in the cell's own SQLite, so it goes to object storage with
// the transcript, survives eviction, and moves with the cell between nodes.
import { Bash, InMemoryFs, defineCommand } from "just-bash/browser";
import { ExecutionError, FileError, LineScanner, err, ok } from "@earendil-works/pi-durable/env";
import { nodeCommand } from "./nodejs.js";
import { npmCommand } from "./npm.js";
import { guardedFetch, wgetCommand } from "./cell-net.js";

// THE WORKSPACE IS /workspace — the path the Kortix client addresses. The SDK
// anchors every host path under it and the daemon serves it. A tree stored
// under the old root is moved on restore; see cellFs().
export const CELL_CWD = "/workspace";
const LEGACY_CWD = "/work";

/** The paths that are the agent's own and therefore durable. */
const durable = (p) => p === CELL_CWD || p.startsWith(`${CELL_CWD}/`) || p.startsWith("/tmp/");

// CHUNKED, because a spread is an argument list: `String.fromCharCode(...u8)`
// dies on a git packfile with "Maximum call stack size exceeded" (2026-09-10).
const b64 = (u8) => {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** pi's FileErrorCode for an error just-bash's filesystem threw. */
export function fileErrorCode(e) {
  const m = String(e?.code ?? "") + " " + String(e?.message ?? "");
  if (/ENOENT|not found|no such/i.test(m)) return "not_found";
  if (/EISDIR|is a directory/i.test(m)) return "is_directory";
  if (/ENOTDIR|not a directory/i.test(m)) return "not_directory";
  if (/EACCES|EPERM|permission denied/i.test(m)) return "permission_denied";
  if (/EEXIST|EINVAL|ENOTEMPTY|file exists|invalid/i.test(m)) return "invalid";
  return "unknown";
}
const fail = (e, path) => err(new FileError(fileErrorCode(e), String(e?.message ?? e), path));

/**
 * just-bash's in-memory tree, recording which paths a write touched.
 *
 * Persisting used to snapshot THE WHOLE TREE after every mutation: every file
 * re-encoded and upserted, so a session with a cloned project paid O(files)
 * SQLite writes, all replicated to the bucket, for a one-line edit. Every write
 * already goes through this object (the shell, the tools, git, the file
 * routes), so recording the touched paths here makes the persisted set exact.
 * A recursive operation marks its root; persist() expands a root to the
 * paths under it.
 */
export class TrackedFs extends InMemoryFs {
  dirty = new Set();
  /** Called with the absolute path of every mutation, as it happens (watch()). */
  listeners = new Set();

  #mark(path) {
    const p = this.resolvePath("/", path);
    this.dirty.add(p);
    for (const listener of this.listeners) {
      try { listener(p); } catch { /* a watcher must not break a write */ }
    }
  }

  async writeFile(path, content, options) { this.#mark(path); return super.writeFile(path, content, options); }
  async appendFile(path, content, options) { this.#mark(path); return super.appendFile(path, content, options); }
  async mkdir(path, options) { this.#mark(path); return super.mkdir(path, options); }
  async createExclusive(path, options) { this.#mark(path); return super.createExclusive(path, options); }
  async rm(path, options) { this.#mark(path); return super.rm(path, options); }
  async cp(src, dest, options) { this.#mark(dest); return super.cp(src, dest, options); }
  async mv(src, dest) { this.#mark(src); this.#mark(dest); return super.mv(src, dest); }
  async chmod(path, mode) { this.#mark(path); return super.chmod(path, mode); }
  async symlink(target, linkPath) { this.#mark(linkPath); return super.symlink(target, linkPath); }
  async link(existingPath, newPath) { this.#mark(newPath); return super.link(existingPath, newPath); }
  async utimes(path, atime, mtime) { this.#mark(path); return super.utimes(path, atime, mtime); }
}

/** One per cell instance: the tree restored from SQLite, and a shell over it. */
export function cellFs(sql) {
  sql.exec("CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, dir INTEGER NOT NULL, mode INTEGER, mtime INTEGER, body TEXT)");
  const fs = new TrackedFs();
  const restored = { dirs: 0, files: 0 };
  const boot = (async () => {
    await fs.mkdir(CELL_CWD, { recursive: true });
    for (const r of [...sql.exec("SELECT path, dir, mode, body FROM files ORDER BY path")]) {
      // A row from before the move to /workspace: the same file, under the
      // workspace root. The old row goes at the next persist of that path.
      const path = r.path === LEGACY_CWD ? CELL_CWD : r.path.startsWith(`${LEGACY_CWD}/`) ? CELL_CWD + r.path.slice(LEGACY_CWD.length) : r.path;
      if (path !== r.path) fs.dirty.add(r.path);
      if (r.dir) {
        await fs.mkdir(path, { recursive: true });
        restored.dirs++;
      } else {
        await fs.mkdir(path.slice(0, path.lastIndexOf("/")) || "/", { recursive: true });
        await fs.writeFile(path, unb64(r.body ?? ""));
        restored.files++;
      }
    }
    // Restoring wrote every path through the tracker; none of it is new.
    for (const p of [...fs.dirty]) if (!p.startsWith(LEGACY_CWD)) fs.dirty.delete(p);
  })();

  // Network: curl (just-bash's own, registered by the fetch) and wget, over the
  // guarded fetch in cell-net.js. The shell's env carries no credential.
  const net = guardedFetch();
  // `node` IS THE ISOLATE ITSELF (nodejs.js): a script the model writes runs
  // here rather than needing a machine.
  const bash = new Bash({
    fs,
    cwd: CELL_CWD,
    env: { HOME: CELL_CWD, PWD: CELL_CWD },
    fetch: net,
    // `sleep` wakes when the running command is aborted. just-bash checks its
    // signal between commands, and a sleep that ignored it held a Stop for
    // the whole duration (`sleep 20` took 20 s to stop).
    sleep: (ms) => new Promise((resolve) => {
      const signal = cell.currentSignal;
      if (signal?.aborted) return resolve();
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener?.("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    }),
    customCommands: [
      wgetCommand(net),
      nodeCommand(defineCommand, { fetch: net }),
      npmCommand(defineCommand, { fetch: net, run: (line, opts) => bash.exec(line, { cwd: opts?.cwd ?? CELL_CWD }) }),
    ],
  });

  /**
   * Write what changed since the last persist to SQLite, and report the
   * changed paths. Only the agent's own tree is durable: just-bash ships a
   * skeleton (/bin, /usr, /etc, 181 paths on an empty cell) that nobody wrote.
   */
  async function persist() {
    await boot;
    const roots = [...fs.dirty];
    fs.dirty.clear();
    if (roots.length === 0) return [];
    const all = fs.getAllPaths();
    const changed = new Set();
    for (const root of roots) {
      if (!durable(root) && !root.startsWith(LEGACY_CWD)) continue;
      const prefix = `${root}/`;
      for (const p of all) if ((p === root || p.startsWith(prefix)) && durable(p)) changed.add(p);
      // Rows that no longer exist under the root are gone.
      for (const r of [...sql.exec("SELECT path FROM files WHERE path = ? OR substr(path, 1, ?) = ?", root, prefix.length, prefix)]) {
        if (!(await fs.exists(r.path)) || !durable(r.path)) {
          sql.exec("DELETE FROM files WHERE path = ?", r.path);
          if (durable(r.path)) changed.add(r.path);
        }
      }
    }
    for (const p of changed) {
      if (!(await fs.exists(p))) continue;
      const st = await fs.stat(p);
      const body = st.isDirectory ? null : b64(await fs.readFileBuffer(p));
      sql.exec(
        "INSERT INTO files(path, dir, mode, mtime, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET dir=excluded.dir, mode=excluded.mode, mtime=excluded.mtime, body=excluded.body",
        p, st.isDirectory ? 1 : 0, st.mode ?? 0o644, Math.floor(+st.mtime || Date.now()), body,
      );
    }
    const paths = [...changed];
    // WHAT CHANGED, for whoever paints the tree: the Files panel re-reads its
    // list on a `file.edited` frame and otherwise shows what it read when it
    // opened (2026-09-10: a file the agent wrote did not appear until the panel
    // was reopened).
    if (paths.length && typeof cell.onChange === "function") {
      try { cell.onChange(paths); } catch { /* a listener must not break a write */ }
    }
    return paths;
  }

  const cell = { fs, bash, persist, ready: boot, restored, onChange: null, net, currentSignal: null, shellEnv: {} };
  return cell;
}

// WHAT THE MODEL IS TOLD ABOUT ITS SHELL. Two facts, not an inventory: it is
// restricted, and it knows the way out.
export function cellShellNote({ machine = false } = {}) {
  return [
    `Your bash tool is a small POSIX shell over this session's own tree at ${CELL_CWD}, which persists between turns.`,
    "It is not a Linux machine: no package manager, no processes. curl and wget work over HTTP(S).",
    "node works here and is real — require, ESM, TypeScript, fs/path/crypto/zlib/http — and `npm install <pkg>` fetches from the registry into node_modules. There are no sockets, no child processes and no lifecycle scripts.",
    machine
      ? "When a task needs a real machine — installs, python, builds, a dev server, git — use the machine tool: it attaches a full Linux environment with the project checked out and runs your command there."
      : "This session has no Linux machine to attach. When a task needs one — python, builds, a dev server, git — say so plainly instead of working around it.",
  ].join("\n");
}

/** The commands this shell has, as `ls /usr/bin` prints them. cellfs-logic pins it. */
export const CELL_COMMANDS = ["alias", "awk", "base64", "basename", "bash", "cat", "chmod", "clear", "column", "comm", "cp", "cut", "date", "diff", "dirname", "du", "echo", "egrep", "env", "expand", "expr", "false", "fgrep", "file", "find", "fold", "grep", "gunzip", "gzip", "head", "help", "history", "hostname", "html-to-markdown", "join", "jq", "ln", "ls", "md5sum", "mkdir", "mktemp", "mv", "nl", "node", "npm", "od", "paste", "printenv", "printf", "pwd", "readlink", "rev", "rg", "rm", "rmdir", "sed", "seq", "sh", "sha1sum", "sha256sum", "sleep", "sort", "split", "stat", "strings", "tac", "tail", "tee", "time", "timeout", "touch", "tr", "tree", "true", "unalias", "unexpand", "uniq", "wc", "which", "whoami", "xargs", "yes", "zcat"];

/** The commands a real box has that this shell does not. */
export const CELL_MISSING = ["git", "ssh", "pnpm", "yarn", "python", "python3", "pip", "docker", "make", "gcc", "apt-get", "tar", "uname"];

/** Network commands, registered by the fetch. */
export const CELL_NET_COMMANDS = ["curl", "wget"];

/** POSIX single-quote one argv word for the shell. */
const shellWord = (w) => `'${String(w).replace(/'/g, "'\\''")}'`;

const encoder = new TextEncoder();
const countLines = (s) => {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
};

/** POSIX `path.join`: segments joined and normalised, a relative result stays relative. */
export function posixJoin(parts) {
  const joined = parts.filter((x) => typeof x === "string" && x !== "").join("/");
  if (joined === "") return ".";
  const absolute = joined.startsWith("/");
  const out = [];
  for (const seg of joined.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length && out.at(-1) !== "..") out.pop();
      else if (!absolute) out.push("..");
    } else out.push(seg);
  }
  const body = out.join("/");
  const trailing = joined.endsWith("/") && body !== "" ? "/" : "";
  return absolute ? `/${body}${trailing}` : (body || ".") + trailing;
}

/** Lines of `text` the way `readTextLines` reports them: no terminators, no phantom last line. */
function splitLines(text) {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * pi-durable's `ExecutionEnv` over the cell's own tree.
 *
 * Every method takes pi's trailing `context` and may be called without one by
 * the cell's own code. `id` is the file namespace: every env over this tree
 * sees the same files.
 */
export function cellExecutionEnv(cell, cwd = CELL_CWD) {
  const { fs, bash, persist, ready } = cell;
  const abs = (p) => fs.resolvePath(cwd, String(p ?? "."));
  const info = async (p, { follow = true } = {}) => {
    const a = abs(p);
    const s = follow ? await fs.stat(a) : await fs.lstat(a);
    return { name: a === "/" ? "/" : a.split("/").pop(), path: a, kind: s.isSymbolicLink ? "symlink" : s.isDirectory ? "directory" : "file", size: s.size ?? 0, mtimeMs: +s.mtime || 0 };
  };
  const aborted = (context) => (context?.abortSignal?.aborted ? err(new FileError("aborted", "aborted")) : null);
  const guard = async (path, fn, context) => {
    const stop = aborted(context);
    if (stop) return stop;
    await ready;
    try {
      return ok(await fn());
    } catch (e) {
      return fail(e, path === undefined ? undefined : abs(path));
    }
  };
  const mutating = async (path, fn, context) => {
    const r = await guard(path, fn, context);
    await persist();
    return r;
  };
  const invalid = (message) => err(new FileError("invalid", message));
  const isCount = (n) => Number.isInteger(n) && n >= 0;

  const env = {
    id: "cell",
    cwd,
    absolutePath: async (p) => ok(abs(p)),
    joinPath: async (parts) => ok(posixJoin(parts)),
    canonicalPath: (p, context) => guard(p, () => (fs.realpath ? fs.realpath(abs(p)) : abs(p)), context),
    readTextFile: (p, context) => guard(p, () => fs.readFile(abs(p), "utf8"), context),
    readTextLines: (p, options, context) => guard(p, async () => {
      const lines = splitLines(await fs.readFile(abs(p), "utf8"));
      return options?.maxLines === undefined ? lines : lines.slice(0, Math.max(0, options.maxLines));
    }, context),
    openTextLineReader: (p, context) => guard(p, async () => {
      const text = await fs.readFile(abs(p), "utf8");
      const parts = text.split(/(\r\n|\n|\r)/);
      const lines = [];
      for (let i = 0; i < parts.length; i += 2) {
        const terminated = i + 1 < parts.length;
        if (parts[i] === "" && !terminated) break;
        lines.push({ text: parts[i], terminated });
      }
      let at = 0;
      return { readLine: async () => ok(lines[at++]), close: async () => {} };
    }, context),
    readBinaryFile: (p, context) => guard(p, () => fs.readFileBuffer(abs(p)), context),
    // THE FILE AS OPENED: the bytes are read once, so a rename or a rewrite of
    // the path afterwards does not change what this reader returns.
    openBinaryReader: (p, options, context) => guard(p, async () => {
      const a = abs(p);
      const s = options?.noFollow ? await fs.lstat(a) : await fs.stat(a);
      if (s.isDirectory) throw Object.assign(new Error(`EISDIR: is a directory, '${a}'`), { code: "EISDIR" });
      if (s.isSymbolicLink) throw Object.assign(new Error(`EINVAL: symbolic link, '${a}'`), { code: "EINVAL" });
      const bytes = await fs.readFileBuffer(a);
      const meta = { name: a.split("/").pop(), path: a, kind: "file", size: bytes.length, mtimeMs: +s.mtime || 0 };
      let open = true;
      const check = (ctx) => (!open ? invalid("the reader is closed") : aborted(ctx));
      return {
        info: async (ctx) => check(ctx) ?? ok({ ...meta }),
        read: async (offset, length, ctx) => {
          const stop = check(ctx);
          if (stop) return stop;
          if (!isCount(offset) || !isCount(length)) return invalid(`invalid range ${offset}+${length}`);
          return ok(bytes.slice(Math.min(offset, bytes.length), Math.min(bytes.length, offset + length)));
        },
        scanLines: async ({ startLine, endLine }, ctx) => {
          const stop = check(ctx);
          if (stop) return stop;
          if (!isCount(startLine) || (endLine !== undefined && (!isCount(endLine) || endLine <= startLine))) {
            return invalid(`invalid line range ${startLine}..${endLine}`);
          }
          const scanner = new LineScanner(startLine, endLine);
          scanner.push(bytes);
          return ok(scanner.finish());
        },
        close: async () => { open = false; },
      };
    }, context),
    // pi's contract: a write creates the parent directories.
    writeFile: (p, content, context) => mutating(p, async () => {
      const a = abs(p);
      await fs.mkdir(a.slice(0, a.lastIndexOf("/")) || "/", { recursive: true });
      await fs.writeFile(a, content);
    }, context),
    appendFile: (p, content, context) => mutating(p, () => fs.appendFile(abs(p), content), context),
    truncateFile: (p, size, context) => mutating(p, async () => {
      const a = abs(p);
      const bytes = (await fs.exists(a)) ? await fs.readFileBuffer(a) : new Uint8Array(0);
      const out = new Uint8Array(size);
      out.set(bytes.subarray(0, Math.min(size, bytes.length)));
      await fs.writeFile(a, out);
    }, context),
    // The tree is persisted on every mutation; flushing is persisting.
    flushFile: (p, context) => guard(p, async () => { await persist(); }, context),
    renameFile: (from, to, context) => mutating(from, () => fs.mv(abs(from), abs(to)), context),
    fileInfo: (p, context) => guard(p, () => info(p, { follow: false }), context),
    listDir: (p, context) => guard(p, async () => {
      const d = abs(p);
      const names = await fs.readdir(d);
      const out = [];
      for (const n of names) {
        try { out.push(await info(`${d}/${n}`, { follow: false })); } catch { /* raced away */ }
      }
      return out;
    }, context),
    openDirReader: (p, context) => guard(p, async () => {
      const d = abs(p);
      const s = await fs.stat(d);
      if (!s.isDirectory) throw Object.assign(new Error(`ENOTDIR: not a directory, '${d}'`), { code: "ENOTDIR" });
      const names = await fs.readdir(d);
      let at = 0;
      let open = true;
      return {
        next: async (maxEntries, ctx) => {
          if (!open) return invalid("the reader is closed");
          const stop = aborted(ctx);
          if (stop) return stop;
          if (!Number.isInteger(maxEntries) || maxEntries < 1) return invalid(`invalid page size ${maxEntries}`);
          const entries = [];
          while (at < names.length && entries.length < maxEntries) {
            // An entry removed since the listing is skipped, as the contract says.
            try { entries.push(await info(`${d}/${names[at]}`, { follow: false })); } catch { /* raced away */ }
            at++;
          }
          return ok({ entries, done: at >= names.length });
        },
        close: async () => { open = false; },
      };
    }, context),
    /**
     * Every mutation of the tree goes through TrackedFs, so a watcher is a
     * filter over those events, reported as they happen: `native`, never
     * polling. A path is reported when it is the target, an ancestor of the
     * target (a parent renamed or created), an entry of a watched directory,
     * or, for a recursive target, anything below it that no exclusion hides.
     */
    watch: (targets, onChange, context) => guard(undefined, async () => {
      const watched = targets.map((t) => ({
        path: abs(t.path),
        recursive: !!t.recursive,
        hidden: !!t.exclude?.hidden,
        names: new Set(t.exclude?.names ?? []),
      }));
      const reports = (p) => watched.some((t) => {
        if (p === t.path || t.path.startsWith(`${p}/`)) return true;
        if (!p.startsWith(`${t.path}/`)) return false;
        const below = p.slice(t.path.length + 1).split("/");
        if (!t.recursive && below.length > 1) return false;
        return !below.some((seg) => (t.hidden && seg.startsWith(".")) || t.names.has(seg));
      });
      let open = true;
      const listener = (p) => {
        if (!open || !reports(p)) return;
        queueMicrotask(() => {
          if (!open) return;
          try { onChange({ paths: [p] }); } catch { /* the caller's problem, not the write's */ }
        });
      };
      fs.listeners.add(listener);
      return {
        mode: "native",
        close: async () => {
          open = false;
          fs.listeners.delete(listener);
        },
      };
    }, context),
    exists: (p, context) => guard(p, () => fs.exists(abs(p)), context),
    // pi's reference environment creates parents unless told not to.
    createDir: (p, options, context) => mutating(p, () => fs.mkdir(abs(p), { recursive: options?.recursive ?? true }), context),
    remove: (p, options, context) => mutating(p, () => fs.rm(abs(p), { recursive: options?.recursive ?? false, force: options?.force ?? false }), context),
    createTempDir: (prefix, context) => mutating(undefined, async () => {
      const d = `/tmp/${prefix ?? "tmp"}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      await fs.mkdir(d, { recursive: true });
      return d;
    }, context),
    createTempFile: (options, context) => mutating(undefined, async () => {
      const f = `/tmp/${options?.prefix ?? "tmp"}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${options?.suffix ?? ""}`;
      await fs.mkdir("/tmp", { recursive: true });
      await fs.writeFile(f, "");
      return f;
    }, context),
    cleanup: async () => {},
    /**
     * Run a command in just-bash. just-bash returns the output when the
     * command finishes, so `onOutput` gets each stream once, stdout first.
     * `timeout` is in seconds (pi's bash tool). Output past the spill
     * thresholds is written whole to a file under /tmp, which the tool names
     * to the model.
     */
    async exec(command, options = {}, context) {
      await ready;
      if (Array.isArray(command) && command.length === 0) return err(new ExecutionError("spawn_error", "empty argv"));
      const script = typeof command === "string" ? command : command.map(shellWord).join(" ");
      const ctl = new AbortController();
      // pi's context, or the `abortSignal` option the cell's own callers pass.
      const parents = [context?.abortSignal, options.abortSignal].filter(Boolean);
      const onAbort = () => ctl.abort();
      if (parents.some((p) => p.aborted)) return err(new ExecutionError("aborted", "aborted before the command started"));
      for (const p of parents) p.addEventListener?.("abort", onAbort, { once: true });
      let timedOut = false;
      const timer = options.timeout ? setTimeout(() => { timedOut = true; ctl.abort(); }, options.timeout * 1000) : null;
      try {
        cell.currentSignal = ctl.signal;
        // RACED WITH THE ABORT, so a Stop answers now even for a command
        // just-bash cannot interrupt mid-way; its result is then discarded.
        const stopped = new Promise((resolve) => {
          if (ctl.signal.aborted) resolve(null);
          ctl.signal.addEventListener("abort", () => resolve(null), { once: true });
        });
        const r = await Promise.race([
          bash.exec(script, {
            cwd: options.cwd ? abs(options.cwd) : cwd,
            // The project's secrets, then whatever the caller adds; never the
            // control plane's own KORTIX_* (the worker filters those).
            env: { ...(cell.shellEnv ?? {}), ...(options.env ?? {}) },
            replaceEnv: options.inheritEnv === false,
            signal: ctl.signal,
          }),
          stopped,
        ]);
        if (r === null) {
          await persist();
          return err(new ExecutionError(timedOut ? "timeout" : "aborted", timedOut ? `timed out after ${options.timeout} s` : "the command was aborted"));
        }
        await persist();
        // just-bash does not throw on abort: it returns exit 124 with "bash:
        // execution aborted". Read the signal, not the shape.
        if (timedOut) return err(new ExecutionError("timeout", `timed out after ${options.timeout} s`));
        if (ctl.signal.aborted) return err(new ExecutionError("aborted", "the command was aborted"));
        const stdout = r.stdout ?? "";
        const stderr = r.stderr ?? "";
        // An argv whose program does not exist never started: a spawn error,
        // not a command that ran and exited 127.
        if (Array.isArray(command) && r.exitCode === 127 && /command not found|not found/i.test(stderr) && stderr.includes(String(command[0]))) {
          return err(new ExecutionError("spawn_error", stderr.trim() || `${command[0]}: not found`));
        }
        let spillPath;
        const spill = options.spill;
        if (spill && (encoder.encode(stdout).length + encoder.encode(stderr).length > spill.afterBytes || countLines(stdout) + countLines(stderr) > spill.afterLines)) {
          spillPath = `/tmp/pi-bash-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.log`;
          await fs.mkdir("/tmp", { recursive: true });
          await fs.writeFile(spillPath, stdout + stderr);
          await persist();
        }
        try {
          if (stdout) options.onOutput?.(stdout, context, { stream: "stdout" });
          if (stderr) options.onOutput?.(stderr, context, { stream: "stderr" });
        } catch (e) {
          return err(new ExecutionError("callback_error", String(e?.message ?? e)));
        }
        // `stdout`/`stderr` ride along for the cell's own callers (machine
        // fs, grep, the terminal); pi reads only `exitCode` and `spillPath`.
        return ok({ exitCode: r.exitCode, ...(spillPath ? { spillPath } : {}), stdout, stderr });
      } catch (e) {
        if (timedOut) return err(new ExecutionError("timeout", `timed out after ${options.timeout} s`));
        if (ctl.signal.aborted) return err(new ExecutionError("aborted", "the command was aborted"));
        return err(new ExecutionError("unknown", String(e?.message ?? e)));
      } finally {
        cell.currentSignal = null;
        if (timer) clearTimeout(timer);
        for (const p of parents) p.removeEventListener?.("abort", onAbort);
      }
    },
  };
  return env;
}

/**
 * Run a command on any pi-durable env and collect its output, for the cell's
 * own callers (the terminal, the machine tool) that want text back rather
 * than a stream.
 */
export async function runCapture(env, command, options = {}, context) {
  let stdout = "";
  let stderr = "";
  const r = await env.exec(command, {
    ...options,
    onOutput: (text, _ctx, meta) => {
      if (meta?.stream === "stderr") stderr += text;
      else stdout += text;
    },
  }, context);
  if (!r.ok) return { ok: false, error: r.error, stdout, stderr };
  return { ok: true, exitCode: r.value.exitCode, stdout, stderr, spillPath: r.value.spillPath };
}
