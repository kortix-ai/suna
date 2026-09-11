// pi's ExecutionEnv over THE ENVIRONMENT'S OWN RPC — the wire the production
// worker speaks to its microVM (apps/kortix-worker/src/kortix-env.ts, served
// by apps/kortix-sandbox-agent-server/src/routes/env-rpc.ts).
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
//
// Same interface as execenv.cell.js and execenv.platinum.js, so the tools that
// run in the cell can run in the machine without knowing which they got.
import { ExecutionError, FileError, err, ok } from "@earendil-works/pi-agent-core";

/** The daemon's errno vocabulary, in pi's FileError codes (kortix-env.ts). */
const FILE_ERROR_CODES = {
  ABORT_ERR: "aborted",
  ENOENT: "not_found",
  EACCES: "permission_denied",
  EPERM: "permission_denied",
  ENOTDIR: "not_directory",
  EISDIR: "is_directory",
  EINVAL: "invalid",
};

export function toFileErrorCode(code) {
  if (typeof code !== "string" || !code) return "unknown";
  const mapped = FILE_ERROR_CODES[code];
  if (mapped) return mapped;
  return /^E[A-Z]+$/.test(code) ? "unknown" : code;
}

/** pi hands a timeout in SECONDS; the daemon SIGKILLs on `timeout` in ms. */
export function toExecTimeoutMs(timeoutSeconds) {
  if (typeof timeoutSeconds !== "number") return undefined;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) return undefined;
  return Math.round(timeoutSeconds * 1000);
}

/** Reads that can be sent twice without a second effect, if the socket dropped. */
const REPLAY_SAFE = new Set([
  "absolutePath", "joinPath", "readTextFile", "readTextLines", "readBinaryFile",
  "fileInfo", "listDir", "canonicalPath", "exists",
]);

const b64url = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const bytesOf = (s) => new TextEncoder().encode(s);

/**
 * Sign the context the daemon verifies. The mirror of kortix-worker's
 * `mintUserContext`: same payload, same HMAC, so a daemon that accepts the
 * worker's accepts the cell's.
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
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * @param {object} o
 * @param {string} o.base       the environment's edge origin, e.g. https://8000-….sbx.platinum.dev
 * @param {string} o.context    the signed X-Kortix-User-Context
 * @param {string} [o.cwd]      /workspace — the checkout on the machine
 * @param {number} [o.timeoutMs]
 * @param {typeof fetch} [o.fetch]
 */
export function envRpcExecutionEnv({ base, context, cwd = "/workspace", timeoutMs = 120_000, fetch: f = globalThis.fetch }) {
  const url = `${String(base).replace(/\/+$/, "")}/kortix/env-rpc/rpc`;
  const calls = [];

  async function once(op, args) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await f(url, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Kortix-User-Context": context },
        body: JSON.stringify({ op, args, cwd }),
        signal: ac.signal,
      });
      // The daemon answers filesystem failures as Results inside a 200; an HTTP
      // error is auth or a malformed request, and is reported as such.
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return err(new FileError("unknown", `environment rpc ${res.status}: ${text.slice(0, 200)}`));
      }
      const body = await res.json().catch(() => null);
      if (body?.ok) return ok(body.value);
      return err(new FileError(toFileErrorCode(body?.error?.code), body?.error?.message ?? "environment error", body?.error?.path));
    } catch (e) {
      return err(new FileError(e?.name === "AbortError" ? "aborted" : "unknown", String(e?.message ?? e)));
    } finally {
      clearTimeout(timer);
    }
  }

  async function rpc(op, args) {
    calls.push({ op });
    const first = await once(op, args);
    if (first.ok) return first;
    if (REPLAY_SAFE.has(op) && /socket|ECONNRESET|closed|EPIPE|fetch failed/i.test(String(first.error?.message ?? ""))) {
      return once(op, args);
    }
    return first;
  }

  return {
    cwd,
    calls,
    absolutePath: (path) => rpc("absolutePath", { path }),
    joinPath: (parts) => rpc("joinPath", { parts }),
    canonicalPath: (path) => rpc("canonicalPath", { path }),
    exists: (path) => rpc("exists", { path }),
    readTextFile: (path) => rpc("readTextFile", { path }),
    readTextLines: (path, options) => rpc("readTextLines", { path, maxLines: options?.maxLines }),
    async readBinaryFile(path) {
      const r = await rpc("readBinaryFile", { path });
      return r.ok ? ok(fromB64(r.value)) : r;
    },
    writeFile(path, content) {
      const bin = typeof content !== "string";
      return rpc("writeFile", { path, content: bin ? toB64(content) : content, encoding: bin ? "base64" : "utf8" });
    },
    appendFile(path, content) {
      const bin = typeof content !== "string";
      return rpc("appendFile", { path, content: bin ? toB64(content) : content, encoding: bin ? "base64" : "utf8" });
    },
    renameFile: (sourcePath, destinationPath) => rpc("renameFile", { sourcePath, destinationPath }),
    fileInfo: (path) => rpc("fileInfo", { path }),
    listDir: (path) => rpc("listDir", { path }),
    createDir: (path, options) => rpc("createDir", { path, recursive: options?.recursive ?? true }),
    remove: (path, options) => rpc("remove", { path, recursive: !!options?.recursive, force: !!options?.force }),
    createTempDir: (prefix) => rpc("createTempDir", { prefix: prefix ?? "tmp-" }),
    createTempFile: (options) => rpc("createTempFile", { prefix: options?.prefix ?? "", suffix: options?.suffix ?? "" }),
    async exec(command, options) {
      const r = await rpc("exec", {
        command,
        cwd: options?.cwd,
        env: options?.env,
        timeout: toExecTimeoutMs(options?.timeout),
      });
      if (!r.ok) return err(new ExecutionError(r.error?.code ?? "unknown", String(r.error?.message ?? "exec failed")));
      // The daemon buffers and answers once; the stream callbacks are honoured
      // after the fact, which is what the production worker does too.
      if (options?.onStdout && r.value.stdout) options.onStdout(r.value.stdout);
      if (options?.onStderr && r.value.stderr) options.onStderr(r.value.stderr);
      return r;
    },
    // No cancel channel on this wire (kortix-env.ts drops abortSignal too): a
    // cancelled turn releases the caller; the command runs to its own timeout.
    idempotent: false,
  };
}
