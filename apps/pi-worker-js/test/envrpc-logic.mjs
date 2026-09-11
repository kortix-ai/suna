// THE ENVIRONMENT'S RPC, FROM THE CELL'S SIDE.
//
// One wire, two speakers: the daemon in the machine
// (apps/kortix-sandbox-agent-server routes/env-rpc.ts) and this client. What
// can go wrong is exactly what went wrong for the production worker before
// it: an errno passed through unmapped broke every file creation, a timeout
// in seconds read as milliseconds killed every command instantly, and a
// binary file sent as text corrupted itself. And one thing that went wrong
// here first: a context signed for the wrong secret, which the daemon answers
// 401 and the proxy turns into "sandbox proxy authentication rejected".
// EXPECTED_PASSES=27
import { watchClaims } from "../../tools/crash-reporter.mjs";
let bad = 0;
const check = watchClaims((n, c, d = "") => { if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });
const { envRpcExecutionEnv, mintUserContext, verifyUserContext, toFileErrorCode, toExecTimeoutMs } = await import("../src/execenv.envrpc.js");

// ── the signed context ──
{
  const ctx = await mintUserContext("s3cret", "sbx_1", { now: 1_700_000_000_000 });
  check("a minted context is payload.signature, both base64url", /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(ctx), ctx.slice(0, 40));
  const v = await verifyUserContext(ctx, "s3cret", { now: 1_700_000_000_000 + 1000 });
  check("and verifies against the same secret, with the claims the daemon reads",
    v.ok && v.claims.sandboxId === "sbx_1" && v.claims.sandboxRole === "owner" && Array.isArray(v.claims.scopes), JSON.stringify(v));
  check("but NOT against another secret — the failure the proxy's re-signing produced live",
    (await verifyUserContext(ctx, "other", { now: 1_700_000_000_000 })).ok === false, "");
  check("and not after it expires: 24 h, the worker's own ttl",
    (await verifyUserContext(ctx, "s3cret", { now: 1_700_000_000_000 + 25 * 3600 * 1000 })).ok === false
      && (await verifyUserContext(ctx, "s3cret", { now: 1_700_000_000_000 + 23 * 3600 * 1000 })).ok === true, "");
  check("a tampered payload fails the signature", (await verifyUserContext(`${ctx.split(".")[0]}x.${ctx.split(".")[1]}`, "s3cret")).ok === false, "");
  check("garbage is malformed, not a throw", (await verifyUserContext("nope", "s3cret")).reason === "malformed", "");
  const noCrypto = await mintUserContext("s", "x", { subtle: null }).catch((e) => e);
  check("no WebCrypto is a plain error, named", noCrypto instanceof Error && /WebCrypto/.test(noCrypto.message), String(noCrypto?.message));
}

// ── the two conversions that broke the production worker ──
check("errno maps to pi's FileError vocabulary: ENOENT is not_found, EACCES is permission_denied",
  toFileErrorCode("ENOENT") === "not_found" && toFileErrorCode("EACCES") === "permission_denied" && toFileErrorCode("EISDIR") === "is_directory", "");
check("an unknown errno is `unknown`; a code that is already pi's passes through",
  toFileErrorCode("EWHATEVER") === "unknown" && toFileErrorCode("not_found") === "not_found" && toFileErrorCode("") === "unknown" && toFileErrorCode(null) === "unknown", "");
check("pi's timeout is SECONDS and the daemon's is ms — 30 becomes 30000, and nothing becomes nothing",
  toExecTimeoutMs(30) === 30_000 && toExecTimeoutMs(0.5) === 500 && toExecTimeoutMs(undefined) === undefined && toExecTimeoutMs(0) === undefined && toExecTimeoutMs(-1) === undefined, "");

// ── the wire, against a fake daemon ──
function fakeDaemon(handler) {
  const seen = [];
  const f = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url, ctx: init.headers["X-Kortix-User-Context"], ...body });
    const r = handler(body);
    if (r instanceof Response) return r;
    return new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { f, seen };
}
{
  const d = fakeDaemon((b) => {
    if (b.op === "readTextFile") return b.args.path === "ok.txt" ? { ok: true, value: "hello" } : { ok: false, error: { code: "ENOENT", message: "no such file", path: b.args.path } };
    if (b.op === "exec") return { ok: true, value: { stdout: `ran ${b.args.command} in ${b.args.cwd ?? "default"} t=${b.args.timeout}`, stderr: "", exitCode: 0 } };
    if (b.op === "readBinaryFile") return { ok: true, value: btoa("\x00\x01\x02") };
    if (b.op === "writeFile") return { ok: true };
    if (b.op === "listDir") return { ok: true, value: [{ name: "a", kind: "file" }] };
    return { ok: false, error: { code: "unknown_op", message: `unsupported op: ${b.op}` } };
  });
  const env = envRpcExecutionEnv({ base: "https://8000-x.sbx.example/", context: "ctx.sig", fetch: d.f });
  check("every call POSTs to <edge>/kortix/env-rpc/rpc with the signed context and the cwd",
    (await env.readTextFile("ok.txt")).value === "hello" && d.seen[0].url === "https://8000-x.sbx.example/kortix/env-rpc/rpc"
      && d.seen[0].ctx === "ctx.sig" && d.seen[0].cwd === "/workspace", JSON.stringify(d.seen[0]));
  const missing = await env.readTextFile("nope.txt");
  check("a daemon Result error becomes a pi FileError with the MAPPED code and the path",
    missing.ok === false && missing.error.code === "not_found" && missing.error.path === "nope.txt", JSON.stringify(missing.error?.code));
  const ran = await env.exec("node -v", { cwd: "/workspace/app", timeout: 45 });
  check("exec passes the command, the cwd and the timeout IN MILLISECONDS",
    ran.ok && ran.value.stdout === "ran node -v in /workspace/app t=45000" && ran.value.exitCode === 0, JSON.stringify(ran.value));
  let streamed = "";
  await env.exec("x", { onStdout: (s) => { streamed += s; } });
  check("stream callbacks are honoured after the fact — the daemon buffers", streamed.startsWith("ran x"), streamed);
  const bin = await env.readBinaryFile("b");
  check("a binary read is decoded from base64 to bytes", bin.ok && bin.value instanceof Uint8Array && bin.value[1] === 1, "");
  await env.writeFile("b.bin", new Uint8Array([255, 0, 1]));
  const w = d.seen.find((s) => s.op === "writeFile");
  check("a binary write is sent base64 with encoding=base64; text stays utf8",
    w.args.encoding === "base64" && w.args.content === btoa("\xff\x00\x01"), JSON.stringify(w.args));
  await env.writeFile("t.txt", "text");
  check("a text write is sent as utf8, untouched", d.seen.at(-1).args.encoding === "utf8" && d.seen.at(-1).args.content === "text", "");
  const unknown = await env.createTempDir();
  check("an op the daemon does not know is an error in pi's shape, not a throw", unknown.ok === false && /unsupported op/.test(unknown.error.message), "");
  check("the env names its cwd and records what it called", env.cwd === "/workspace" && env.calls.some((c) => c.op === "exec"), "");
  check("and declares itself NOT idempotent — no op ledger on this wire", env.idempotent === false, "");
}
{
  // HTTP failures are auth or a bad request, and they are reported as such
  // rather than parsed as Results.
  const d = fakeDaemon(() => new Response(JSON.stringify({ error: "unauthorized", reason: "bad signature" }), { status: 401 }));
  const env = envRpcExecutionEnv({ base: "https://e", context: "wrong", fetch: d.f });
  const r = await env.exists("x");
  check("a 401 from the daemon is a FileError naming the status — the wrong-secret failure, said plainly",
    r.ok === false && /rpc 401/.test(r.error.message) && /bad signature/.test(r.error.message), r.error?.message);
  const rx = await env.exec("x");
  check("and for exec it is an ExecutionError, the type pi's bash tool reads", rx.ok === false && rx.error?.name === "ExecutionError", String(rx.error?.name));
}
{
  // A dropped socket on a READ is retried once; on a write it is not.
  let calls = 0;
  const f = async () => { calls++; if (calls === 1) throw new TypeError("fetch failed: socket hang up"); return new Response(JSON.stringify({ ok: true, value: true }), { status: 200 }); };
  const env = envRpcExecutionEnv({ base: "https://e", context: "c", fetch: f });
  check("a replay-safe read is sent again after a dropped socket", (await env.exists("x")).ok === true && calls === 2, String(calls));
  calls = 0;
  const w = await env.writeFile("x", "y");
  check("a WRITE is not — it may have landed, and twice is not the same as once", w.ok === false && calls === 1, String(calls));
}
{
  // The client's own timeout releases the caller.
  const f = (_u, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const env = envRpcExecutionEnv({ base: "https://e", context: "c", fetch: f, timeoutMs: 20 });
  const r = await env.readTextFile("slow");
  check("a call past the client timeout comes back `aborted` rather than hanging the turn", r.ok === false && r.error.code === "aborted", JSON.stringify(r.error?.code));
}
{
  const d = fakeDaemon((b) => ({ ok: true, value: b.args }));
  const env = envRpcExecutionEnv({ base: "https://e", context: "c", fetch: d.f });
  check("createDir defaults to recursive and remove to neither recursive nor force — the daemon's own defaults, made explicit",
    (await env.createDir("a/b")).value.recursive === true && JSON.stringify((await env.remove("x")).value) === JSON.stringify({ path: "x", recursive: false, force: false }), "");
  check("readTextLines carries maxLines; fileInfo, listDir, canonicalPath, exists, joinPath, absolutePath, renameFile, appendFile, createTempFile all reach the wire by their daemon names",
    (await env.readTextLines("f", { maxLines: 3 })).value.maxLines === 3
      && (await Promise.all(["fileInfo", "listDir", "canonicalPath", "exists", "absolutePath"].map((op) => env[op]("p")))).every((r) => r.ok)
      && (await env.joinPath(["a", "b"])).value.parts.length === 2
      && (await env.renameFile("a", "b")).value.destinationPath === "b"
      && (await env.appendFile("a", "x")).value.encoding === "utf8"
      && (await env.createTempFile({ suffix: ".t" })).value.suffix === ".t",
    JSON.stringify(d.seen.map((s) => s.op)));
}

console.log(bad ? `\n${bad} FAILED` : "\nall claims hold");
process.exit(bad ? 1 : 0);
