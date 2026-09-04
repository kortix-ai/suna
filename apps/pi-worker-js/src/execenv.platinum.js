// pi's ExecutionEnv over PLATINUM'S OWN SANDBOX API.
//
// The daemon version (execenv.js) proves pi's tools run against a remote
// workspace. This is the one that matters for the product: the same interface
// over /v1/sandboxes/:id/exec and /files*, with a `sandbox:<id>`-scoped key —
// the credential sandboxScope.ts was built to hand an agent. Audit, billing,
// quotas, the spend gate and org isolation come with it, none of which the
// daemon has.
//
// What Platinum has natively:  exec, files GET/PUT, files/stat, files/list,
//                              files/grep, files/find, files/replace.
// What it does not:            append, rename, mkdir, remove, canonical.
//
// The second group goes through /exec with a shell command. That is not a
// shortcut to be embarrassed about — the sandbox IS a shell, and a route per
// filesystem verb would be re-implementing coreutils over vsock. It is noted
// per method so nobody wonders.
//
// Shapes, from apps/api/src/api/sandboxes.ts and invmAgent.ts:
//   GET  /files/stat  -> {ok, size, mode, is_dir, mtime}       404 when missing
//   GET  /files/list  -> {ok, entries: [{name, size, mode, is_dir}]}
//   GET  /files       -> the file body, raw
//   PUT  /files       -> {ok}
//   POST /exec        -> {result: {ok, stdout, stderr, exit_code}}
import { ExecutionError, FileError, err, ok } from "@earendil-works/pi-agent-core";

const fail = (message, path, code = "unknown") => err(new FileError(code, String(message), path));

/** Shell-quote one argument. Paths are the model's; never interpolate them raw. */
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// PREFIX COMPARISON IS NOT PATH COMPARISON.
//
// An absolute path is treated as inside the workspace when it starts with cwd,
// as a string. That breaks the moment the sandbox's own idea of cwd differs by
// so much as a symlink — and it does: canonicalPath runs `readlink -f`, and on
// a workspace reached through one, its answer comes back with a different
// prefix than the cwd this env was configured with.
//
// pi's edit tool calls canonicalPath and feeds the result straight back into
// read and write, so the failure is not theoretical: every edit after a
// canonicalPath reports not_found on a file that plainly exists. Measured with
// cwd=/tmp/... on a host where /tmp is a symlink to /private/tmp.
//
// `alsoInside` carries the sandbox's canonical form of cwd once it is known, so
// both spellings resolve. Nothing here guesses at containment — a path under
// neither is left alone for the platform to refuse.
function rel(p, cwd, alsoInside) {
  const s = String(p ?? "");
  // AUDIT-EQUIVALENT: a relative path reaches the same answer below — both bases
  // are absolute, so it matches neither, and the leading-slash strip finds no
  // slash. Kept because "already relative, nothing to do" is the case a reader
  // looks for first, and the same guard is spelled the same way in execenv.js.
  if (!s.startsWith("/")) return s;
  for (const base of [cwd, alsoInside]) {
    if (base && s.startsWith(base)) return s.slice(base.length).replace(/^\/+/, "");
  }
  return s.replace(/^\/+/, "");
}

export function platinumExecutionEnv({ apiUrl, key, sandboxId, cwd = "/home/user" }) {
  const base = `${String(apiUrl).replace(/\/+$/, "")}/v1/sandboxes/${sandboxId}`;

  async function api(method, path, { query, body, raw, signal } = {}) {
    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
    if (raw) return res;
    const text = await res.text();
    let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text.slice(0, 300) }; }
    return { status: res.status, json };
  }

  // Absolute inside the sandbox. Platinum paths are sandbox-absolute, so a
  // relative path is joined onto cwd rather than left for the guest to guess.
  // Learned from the sandbox the first time canonicalPath is called, and used
  // for prefix matching from then on.
  let canonicalCwd = null;
  const abs = (p) => { const r = rel(p, cwd, canonicalCwd); return r.startsWith("/") ? r : `${cwd}/${r}`.replace(/\/+/g, "/"); };

  async function sh(command, timeoutMs = 30_000, signal) {
    const r = await api("POST", "/exec", { body: { cmd: command, timeout_ms: Math.min(Math.max(timeoutMs, 100), 300_000) }, signal });
    if (r.status !== 200) return { ok: false, status: r.status, error: r.json?.error ?? `exec ${r.status}`, code: r.json?.code };
    const res = r.json.result ?? {};
    return { ok: true, stdout: res.stdout ?? "", stderr: res.stderr ?? "", exitCode: res.exit_code ?? (res.ok ? 0 : -1) };
  }

  const codeFor = (status, msg = "") =>
    status === 404 || /no such file|ENOENT|not found/i.test(msg) ? "not_found" :
    status === 403 ? "permission_denied" : "unknown";

  return {
    cwd,

    // Platinum's /exec takes no idempotency key, so nothing underneath this can
    // tell a delivered command from an undelivered one. A call the cell
    // recorded as 'running' must NOT be re-dispatched here.
    idempotent: false,

    async absolutePath(path) { return ok(abs(path)); },
    async joinPath(parts) { return ok(parts.filter(Boolean).join("/").replace(/\/+/g, "/")); },

    async readTextFile(path) {
      const res = await api("GET", "/files", { query: { path: abs(path) }, raw: true });
      if (res.status !== 200) { const t = await res.text(); return fail(t.slice(0, 200) || `read ${res.status}`, path, codeFor(res.status, t)); }
      return ok(await res.text());
    },

    async readTextLines(path, options = {}) {
      const res = await api("GET", "/files", { query: { path: abs(path), offset: 0, limit: options.maxLines }, raw: true });
      if (res.status !== 200) { const t = await res.text(); return fail(t.slice(0, 200) || `read ${res.status}`, path, codeFor(res.status, t)); }
      return ok((await res.text()).split("\n"));
    },

    async readBinaryFile(path) {
      // The route returns the body raw, so bytes survive — pi's edit tool reads
      // bytes before rewriting, and this is why the daemon needed base64.
      const res = await api("GET", "/files", { query: { path: abs(path) }, raw: true });
      if (res.status !== 200) { const t = await res.text(); return fail(t.slice(0, 200) || `read ${res.status}`, path, codeFor(res.status, t)); }
      return ok(new Uint8Array(await res.arrayBuffer()));
    },

    async writeFile(path, content) {
      const text = typeof content === "string" ? content : new TextDecoder().decode(content);
      const r = await api("PUT", "/files", { query: { path: abs(path) }, body: { content: text } });
      return r.status === 200 ? ok(undefined) : fail(r.json?.error ?? `write ${r.status}`, path, codeFor(r.status, r.json?.error));
    },

    // No route: `>>` in the sandbox's own shell.
    async appendFile(path, content) {
      const text = typeof content === "string" ? content : new TextDecoder().decode(content);
      const r = await sh(`mkdir -p "$(dirname ${q(abs(path))})" && printf '%s' ${q(text)} >> ${q(abs(path))}`);
      return r.ok && r.exitCode === 0 ? ok(undefined) : fail(r.error ?? r.stderr ?? "append failed", path);
    },

    // No route: mv, which is atomic on one filesystem exactly as the contract asks.
    async renameFile(from, to) {
      const r = await sh(`mv -f ${q(abs(from))} ${q(abs(to))}`);
      return r.ok && r.exitCode === 0 ? ok(undefined) : fail(r.error ?? r.stderr ?? "rename failed", from);
    },

    async fileInfo(path) {
      const r = await api("GET", "/files/stat", { query: { path: abs(path) } });
      if (r.status !== 200 || !r.json.ok) return fail(r.json?.error ?? `stat ${r.status}`, path, codeFor(r.status, r.json?.error));
      const a = abs(path);
      return ok({ name: a.split("/").pop(), path: a, kind: r.json.is_dir ? "directory" : "file", size: r.json.size ?? 0, mtimeMs: (r.json.mtime ?? 0) * (r.json.mtime > 1e12 ? 1 : 1000) });
    },

    async listDir(path) {
      const r = await api("GET", "/files/list", { query: { path: abs(path) } });
      if (r.status !== 200 || !r.json.ok) return fail(r.json?.error ?? `list ${r.status}`, path, codeFor(r.status, r.json?.error));
      const dir = abs(path);
      return ok((r.json.entries ?? []).map((e) => ({ name: e.name, path: `${dir}/${e.name}`.replace(/\/+/g, "/"), kind: e.is_dir ? "directory" : "file", size: e.size ?? 0, mtimeMs: 0 })));
    },

    // No route: readlink -f, and pi calls this for paths that do not exist yet,
    // so a missing target falls back to the addressed path.
    async canonicalPath(path) {
      const target = abs(path);
      const r = await sh(`readlink -f ${q(target)} 2>/dev/null || echo ${q(target)}`);
      if (!r.ok) return fail(r.error ?? "canonical failed", path);
      const resolved = r.stdout.trim() || target;
      // Learn the sandbox's own spelling of cwd from the answer, so the result
      // can be handed straight back in — which is exactly what pi does.
      if (!canonicalCwd && resolved !== target && target.startsWith(cwd)) {
        const tail = target.slice(cwd.length);
        if (tail && resolved.endsWith(tail)) canonicalCwd = resolved.slice(0, resolved.length - tail.length);
      }
      return ok(resolved);
    },

    async exists(path) {
      const r = await api("GET", "/files/stat", { query: { path: abs(path) } });
      if (r.status === 200 && r.json.ok) return ok(true);
      if (r.status === 404) return ok(false);
      return fail(r.json?.error ?? `stat ${r.status}`, path, codeFor(r.status, r.json?.error));
    },

    async createDir(path, options = {}) {
      const r = await sh(`mkdir ${options.recursive === false ? "" : "-p"} ${q(abs(path))}`);
      return r.ok && r.exitCode === 0 ? ok(undefined) : fail(r.error ?? r.stderr ?? "mkdir failed", path);
    },

    async remove(path, options = {}) {
      const r = await sh(`rm -f ${options.recursive ? "-r" : ""} ${q(abs(path))}`);
      return r.ok && r.exitCode === 0 ? ok(undefined) : fail(r.error ?? r.stderr ?? "remove failed", path);
    },

    async createTempDir(prefix = "tmp") {
      const p = `${cwd}/.tmp/${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const r = await sh(`mkdir -p ${q(p)}`);
      return r.ok && r.exitCode === 0 ? ok(p) : fail(r.error ?? "mkdtemp failed", p);
    },

    async createTempFile(options = {}) {
      const p = `${cwd}/.tmp/${options.prefix ?? "tmp"}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${options.suffix ?? ""}`;
      const r = await api("PUT", "/files", { query: { path: p }, body: { content: "" } });
      return r.status === 200 ? ok(p) : fail(r.json?.error ?? "temp file failed", p);
    },

    async cleanup() { /* the sandbox outlives the cell */ },

    async exec(command, options = {}) {
      // The Shell contract: run in FileSystem.cwd unless options.cwd says
      // otherwise. Platinum's /exec has no cwd parameter — it runs where the
      // guest agent starts — so the env has to establish it. Without this,
      // pi's bash tool ran `cat gen/out.txt` in the wrong directory, got exit
      // 1, and threw, while every filesystem tool beside it worked.
      const dir = options.cwd ? abs(options.cwd) : cwd;
      // pi calls it `abortSignal`. Passing it releases the caller when a turn is
      // cancelled; unlike the daemon, Platinum's /exec has no cancel channel, so
      // the command keeps running in the sandbox until its own timeout. That is
      // the honest limit of this path, not something this layer can fix.
      const r = await sh(`cd ${q(dir)} && ${command}`, (options.timeout ?? 120) * 1000, options.abortSignal);
      // THE OUTPUT GOES THROUGH THE CALLBACKS, not only the return value.
      //
      // pi's bash tool captures what a command printed from onStdout/onStderr —
      // the returned stdout is not what it reads. Without these it reported
      // "(no output)" for a command that had produced output and exited 0, and
      // the model would have seen an empty result for every successful command.
      // Both are delivered as one chunk because the transport is not streaming.
      if (r.ok) {
        if (r.stdout && options.onStdout) options.onStdout(r.stdout);
        if (r.stderr && options.onStderr) options.onStderr(r.stderr);
      }
      if (!r.ok) {
        // 504 exec_timeout is Platinum refusing to re-dispatch a delivered
        // command — a timeout, not a broken environment.
        // The platform's own code travels with the message. pi's ExecutionError
        // kinds are a short list — a 403 is "unknown" to pi — and without this
        // a scope refusal reaches the transcript as prose with no
        // machine-readable reason left in it.
        return err(new ExecutionError(
          r.code === "exec_timeout" ? "timeout" : "unknown",
          r.code ? `${r.error} [${r.status ?? ""} ${r.code}]`.replace(/\s+/g, " ") : String(r.error),
        ));
      }
      return ok({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode });
    },
  };
}
