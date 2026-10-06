// pi-durable's ExecutionEnv over THE ENVIRONMENT'S OWN RPC — the wire the
// sandbox daemon serves at `/kortix/env-rpc` (apps/kortix-sandbox-agent-server
// src/routes/kortix/env-rpc.ts).
//
// A cell is a shell over an in-memory tree: no runtimes, no package manager,
// no processes. The full Linux machine a session may need is its ENVIRONMENT,
// a second box the control plane provisions from the project's own image on
// the first ask (environment.js). This is how the cell drives it once it
// exists: one POST per operation, `{op, args, cwd}` in, `{ok, value}` or
// `{ok:false, error:{code, message, path}}` out, over the provider's public
// edge — never the Kortix proxy, which re-signs the auth header with the
// wrong key and turned every call into a 401 (measured on dev 2026-09-11).
//
// Auth is a signed context in `X-Kortix-User-Context`: base64url(payload) "."
// base64url(HMAC-SHA256(payload, secret)), the secret being the one the
// control plane minted for this environment and handed back from `ensure`.
// The daemon checks the signature and the expiry and nothing else in it.
import { ExecutionError, FileError, LineScanner, err, ok } from "@earendil-works/pi-durable/env";

/** The daemon's errno vocabulary, in pi's FileError codes. */
const FILE_ERROR_CODES = {
  ABORT_ERR: "aborted",
  ENOENT: "not_found",
  EACCES: "permission_denied",
  EPERM: "permission_denied",
  ENOTDIR: "not_directory",
  EISDIR: "is_directory",
  EINVAL: "invalid",
  EEXIST: "invalid",
  ENOTEMPTY: "invalid",
};
const PI_FILE_CODES = new Set(["aborted", "not_found", "permission_denied", "not_directory", "is_directory", "invalid", "not_supported", "unknown"]);

export function toFileErrorCode(code) {
  if (typeof code !== "string" || !code) return "unknown";
  if (FILE_ERROR_CODES[code]) return FILE_ERROR_CODES[code];
  return PI_FILE_CODES.has(code) ? code : "unknown";
}

/** pi hands a timeout in SECONDS; the daemon SIGKILLs on `timeout` in ms. */
export function toExecTimeoutMs(timeoutSeconds) {
  if (typeof timeoutSeconds !== "number") return undefined;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) return undefined;
  return Math.round(timeoutSeconds * 1000);
}

/**
 * Operations a second send cannot change the outcome of: reads, and a
 * whole-file write (the same bytes twice leave the same file). Retried once,
 * and only when the request never got an answer (the fetch threw). An answer —
 * any HTTP status, any Result — is final: the daemon may have applied it.
 */
const REPLAY_SAFE = new Set([
  "absolutePath", "joinPath", "readTextFile", "readTextLines", "readBinaryFile",
  "fileInfo", "listDir", "canonicalPath", "exists", "writeFile",
]);

const b64url = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const bytesOf = (s) => new TextEncoder().encode(s);

/**
 * Sign the context the daemon verifies: the same payload and HMAC the sandbox
 * daemon's `verifyKortixUserContext` checks.
 */
export async function mintUserContext(secret, sandboxId, { now = Date.now(), ttlSeconds = 24 * 3600, subtle = globalThis.crypto?.subtle } = {}) {
  if (!subtle) throw new Error("no WebCrypto: cannot sign the environment context");
  const iat = Math.floor(now / 1000);
  const payload = b64url(bytesOf(JSON.stringify({
    userId: "pi-cell", sandboxId, sandboxRole: "owner", scopes: [], iat, exp: iat + ttlSeconds,
  })));
  const key = await subtle.importKey("raw", bytesOf(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await subtle.sign("HMAC", key, bytesOf(payload)));
  return `${payload}.${b64url(sig)}`;
}

/** The daemon's check, for the claims: a context is valid iff the signature holds and it has not expired. */
export async function verifyUserContext(token, secret, { now = Date.now(), subtle = globalThis.crypto?.subtle } = {}) {
  const [payload, sig] = String(token ?? "").split(".");
  if (!payload || !sig) return { ok: false, reason: "malformed" };
  const key = await subtle.importKey("raw", bytesOf(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expect = b64url(new Uint8Array(await subtle.sign("HMAC", key, bytesOf(payload))));
  if (expect !== sig) return { ok: false, reason: "bad signature" };
  let claims;
  try { claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))); } catch { return { ok: false, reason: "bad payload" }; }
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}

const toB64 = (u8) => {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const shellWord = (w) => `'${String(w).replace(/'/g, "'\\''")}'`;
const encoder = new TextEncoder();
const countLines = (s) => {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
};

/**
 * @param {object} o
 * @param {string} o.base       the environment's edge origin, e.g. https://8000-….sbx.platinum.dev
 * @param {string} o.context    the signed X-Kortix-User-Context
 * @param {string} [o.cwd]      /workspace — the checkout on the machine
 * @param {number} [o.timeoutMs]
 * @param {typeof fetch} [o.fetch]
 */
export function envRpcExecutionEnv({ base, context: userContext, cwd = "/workspace", timeoutMs = 120_000, fetch: f = globalThis.fetch }) {
  const url = `${String(base).replace(/\/+$/, "")}/kortix/env-rpc/rpc`;
  const calls = [];

  async function once(op, args, context, budgetMs = timeoutMs) {
    const signals = [AbortSignal.timeout(budgetMs)];
    if (context?.abortSignal) signals.push(context.abortSignal);
    let res;
    try {
      res = await f(url, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Kortix-User-Context": userContext },
        body: JSON.stringify({ op, args, cwd }),
        signal: AbortSignal.any(signals),
      });
    } catch (e) {
      if (context?.abortSignal?.aborted) return { result: err(new FileError("aborted", "aborted")), answered: false };
      return { result: err(new FileError("unknown", String(e?.message ?? e))), answered: false, transport: true };
    }
    // The daemon answers filesystem failures as Results inside a 200; an HTTP
    // error is auth or a malformed request, and is reported as such.
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { result: err(new FileError("unknown", `environment rpc ${res.status}: ${text.slice(0, 200)}`)), answered: true };
    }
    const body = await res.json().catch(() => null);
    if (body?.ok) return { result: ok(body.value), answered: true };
    return { result: err(new FileError(toFileErrorCode(body?.error?.code), body?.error?.message ?? "environment error", body?.error?.path)), answered: true };
  }

  async function rpc(op, args, context, budgetMs) {
    if (context?.abortSignal?.aborted) return err(new FileError("aborted", "aborted"));
    calls.push({ op });
    const first = await once(op, args, context, budgetMs);
    if (first.transport && REPLAY_SAFE.has(op)) return (await once(op, args, context, budgetMs)).result;
    return first.result;
  }

  const readBinary = async (path, context) => {
    const r = await rpc("readBinaryFile", { path }, context);
    return r.ok ? ok(fromB64(r.value)) : r;
  };

  const env = {
    id: `machine:${String(base).replace(/\/+$/, "")}`,
    cwd,
    calls,
    absolutePath: (path, context) => rpc("absolutePath", { path }, context),
    joinPath: (parts, context) => rpc("joinPath", { parts }, context),
    canonicalPath: (path, context) => rpc("canonicalPath", { path }, context),
    exists: (path, context) => rpc("exists", { path }, context),
    readTextFile: (path, context) => rpc("readTextFile", { path }, context),
    readTextLines: (path, options, context) => rpc("readTextLines", { path, maxLines: options?.maxLines }, context),
    readBinaryFile: readBinary,
    async openTextLineReader(path, context) {
      const r = await rpc("readTextFile", { path }, context);
      if (!r.ok) return r;
      const parts = r.value.split(/(\r\n|\n|\r)/);
      const lines = [];
      for (let i = 0; i < parts.length; i += 2) {
        const terminated = i + 1 < parts.length;
        if (parts[i] === "" && !terminated) break;
        lines.push({ text: parts[i], terminated });
      }
      let at = 0;
      return ok({ readLine: async () => ok(lines[at++]), close: async () => {} });
    },
    // The daemon has no range read, so the reader holds the file it read once.
    // Bounded by the daemon's own whole-file answer.
    async openBinaryReader(path, _options, context) {
      const infoResult = await rpc("fileInfo", { path }, context);
      if (!infoResult.ok) return infoResult;
      if (infoResult.value?.kind === "directory") return err(new FileError("is_directory", "is a directory", path));
      const bytes = await readBinary(path, context);
      if (!bytes.ok) return bytes;
      const meta = { ...infoResult.value, size: bytes.value.length };
      let open = true;
      const check = (ctx) => (!open ? err(new FileError("invalid", "the reader is closed")) : ctx?.abortSignal?.aborted ? err(new FileError("aborted", "aborted")) : null);
      const isCount = (n) => Number.isInteger(n) && n >= 0;
      return ok({
        info: async (ctx) => check(ctx) ?? ok({ ...meta }),
        read: async (offset, length, ctx) => {
          const stop = check(ctx);
          if (stop) return stop;
          if (!isCount(offset) || !isCount(length)) return err(new FileError("invalid", `invalid range ${offset}+${length}`));
          return ok(bytes.value.slice(Math.min(offset, bytes.value.length), Math.min(bytes.value.length, offset + length)));
        },
        scanLines: async ({ startLine, endLine }, ctx) => {
          const stop = check(ctx);
          if (stop) return stop;
          if (!isCount(startLine) || (endLine !== undefined && (!isCount(endLine) || endLine < startLine))) {
            return err(new FileError("invalid", `invalid line range ${startLine}..${endLine}`));
          }
          const scanner = new LineScanner(startLine, endLine);
          scanner.push(bytes.value);
          return ok(scanner.finish());
        },
        close: async () => { open = false; },
      });
    },
    writeFile(path, content, context) {
      const bin = typeof content !== "string";
      return rpc("writeFile", { path, content: bin ? toB64(content) : content, encoding: bin ? "base64" : "utf8" }, context);
    },
    appendFile(path, content, context) {
      const bin = typeof content !== "string";
      return rpc("appendFile", { path, content: bin ? toB64(content) : content, encoding: bin ? "base64" : "utf8" }, context);
    },
    async truncateFile(path, size, context) {
      if (!Number.isInteger(size) || size < 0) return err(new FileError("invalid", `invalid size ${size}`));
      const r = await env.exec(["truncate", "-s", String(size), path], undefined, context);
      if (!r.ok) return err(new FileError("unknown", r.error.message, path));
      return r.value.exitCode === 0 ? ok(undefined) : err(new FileError("unknown", `truncate exited ${r.value.exitCode}`, path));
    },
    async flushFile(path, context) {
      const r = await env.exec(["sync", path], undefined, context);
      return r.ok ? ok(undefined) : err(new FileError("unknown", r.error.message, path));
    },
    renameFile: (sourcePath, destinationPath, context) => rpc("renameFile", { sourcePath, destinationPath }, context),
    fileInfo: (path, context) => rpc("fileInfo", { path }, context),
    listDir: (path, context) => rpc("listDir", { path }, context),
    async openDirReader(path, context) {
      const r = await rpc("listDir", { path }, context);
      if (!r.ok) return r;
      const entries = r.value ?? [];
      let at = 0;
      let open = true;
      return ok({
        next: async (maxEntries, ctx) => {
          if (!open) return err(new FileError("invalid", "the reader is closed"));
          if (ctx?.abortSignal?.aborted) return err(new FileError("aborted", "aborted"));
          if (!Number.isInteger(maxEntries) || maxEntries < 1) return err(new FileError("invalid", `invalid page size ${maxEntries}`));
          const page = entries.slice(at, at + maxEntries);
          at += page.length;
          return ok({ entries: page, done: at >= entries.length });
        },
        close: async () => { open = false; },
      });
    },
    // Nothing loads resources from the machine by watching it.
    watch: async () => err(new FileError("not_supported", "the environment rpc has no change feed")),
    createDir: (path, options, context) => rpc("createDir", { path, recursive: options?.recursive ?? true }, context),
    remove: (path, options, context) => rpc("remove", { path, recursive: !!options?.recursive, force: !!options?.force }, context),
    createTempDir: (prefix, context) => rpc("createTempDir", { prefix: prefix ?? "tmp-" }, context),
    createTempFile: (options, context) => rpc("createTempFile", { prefix: options?.prefix ?? "", suffix: options?.suffix ?? "" }, context),
    cleanup: async () => {},
    /**
     * One RPC; the daemon runs `bash -lc` and answers once with the whole
     * output, so `onOutput` sees each stream once, after the fact. There is no
     * cancel channel on this wire: an aborted turn releases the caller, and the
     * command runs on to its own timeout.
     */
    async exec(command, options = {}, context) {
      if (Array.isArray(command) && command.length === 0) return err(new ExecutionError("spawn_error", "empty argv"));
      if (context?.abortSignal?.aborted || options.abortSignal?.aborted) return err(new ExecutionError("aborted", "aborted"));
      if (options.abortSignal && !context?.abortSignal) context = { ...(context ?? {}), abortSignal: options.abortSignal };
      const line = typeof command === "string" ? command : command.map(shellWord).join(" ");
      const ms = toExecTimeoutMs(options.timeout);
      const r = await rpc("exec", { command: line, cwd: options.cwd, env: options.env, timeout: ms },
        context, (ms ?? timeoutMs) + 15_000);
      if (!r.ok) {
        const code = r.error?.code === "aborted" ? "aborted" : "unknown";
        return err(new ExecutionError(code, String(r.error?.message ?? "exec failed")));
      }
      const { stdout = "", stderr = "", exitCode = 1 } = r.value ?? {};
      if (exitCode === 124 && /\[killed: exceeded \d+ms\]/.test(stderr)) {
        return err(new ExecutionError("timeout", `timed out after ${options.timeout} s`));
      }
      if (Array.isArray(command) && exitCode === 127 && stderr.includes(String(command[0]))) {
        return err(new ExecutionError("spawn_error", stderr.trim()));
      }
      let spillPath;
      const spill = options.spill;
      if (spill && (encoder.encode(stdout).length + encoder.encode(stderr).length > spill.afterBytes || countLines(stdout) + countLines(stderr) > spill.afterLines)) {
        const made = await rpc("createTempFile", { prefix: "pi-bash-", suffix: ".log" }, context);
        if (made.ok && (await rpc("writeFile", { path: made.value, content: stdout + stderr, encoding: "utf8" }, context)).ok) spillPath = made.value;
      }
      try {
        if (stdout) options.onOutput?.(stdout, context, { stream: "stdout" });
        if (stderr) options.onOutput?.(stderr, context, { stream: "stderr" });
      } catch (e) {
        return err(new ExecutionError("callback_error", String(e?.message ?? e)));
      }
      // `stdout`/`stderr` ride along for the cell's own callers; pi reads only
      // `exitCode` and `spillPath`.
      return ok({ exitCode, ...(spillPath ? { spillPath } : {}), stdout, stderr });
    },
  };
  return env;
}
