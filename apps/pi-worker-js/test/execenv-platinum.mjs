// pi's REAL tools over PLATINUM'S API — the product path.
//
// execenv-logic.mjs proves the ExecutionEnv idea against the daemon. This is
// the one that matters: the same pi tools (edit above all) over
// /v1/sandboxes/:id/exec and /files*, driven against the stub that implements
// those routes as apps/api defines them, including the sandbox-scope refusal.
//
// The stub's ROOT stands in for the sandbox's filesystem, so `cwd` is a path
// under it — in the real sandbox it is /home/user inside the VM.
// Read by test/all.sh. The suite's own tail line catches a section that ran
// and produced nothing; it cannot catch an exit partway through, which skips
// the tail entirely. This is the number that check compares against.
// EXPECTED_PASSES=61

import { createEditTool, createReadTool, createWriteTool, createBashTool } from "@earendil-works/pi-agent-core";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { platinumExecutionEnv } from "../src/execenv.platinum.js";
import { watchClaims } from "../../tools/crash-reporter.mjs";

// ── THE RESPONSE SHAPE, READ FROM apps/api RATHER THAN COPIED ───────────────
//
// The stub imitates apps/api's routes by hand, and every claim in this file
// runs against the stub. So a rename on the platform side — is_dir becoming
// isDir, mtime becoming modified_at — leaves all of them green while
// fileInfo() silently reports every directory as a file and every mtime as
// 1970. The env maps those exact names; nothing else would notice.
//
// invmAgent.ts declares the shapes as TypeScript types on the rpcJSON calls,
// which is a fact in the repo. Parsed here, strictly: if the declaration is not
// found, the claims FAIL rather than skip.
import { havePlatinum, platinumPath } from "./platinum-repo.mjs";
if (!havePlatinum) { console.log("  SKIP: no Platinum checkout — this suite reads Platinum's source (set PLATINUM_REPO)"); process.exit(0); }
const INVM_SRC = platinumPath("apps/api/src/invmAgent.ts");
const SANDBOXES_SRC = platinumPath("apps/api/src/api/sandboxes.ts");

function guestFileShapes() {
  let src;
  try { src = readFileSync(INVM_SRC, "utf8"); }
  catch (e) { return { error: `cannot read ${INVM_SRC}: ${e.message}` }; }
  // The open paren matters. Without it `statFile` also matches `statFileV2`,
  // so renaming the function still found a declaration and the parse-failure
  // claim could not fail — verified by mutation.
  const stat = /export async function statFile\([\s\S]*?rpcJSON<\{([^}]*)\}>/.exec(src);
  const list = /export async function listDir\([\s\S]*?entries\?: Array<\{([^}]*)\}>/.exec(src);
  if (!stat) return { error: "statFile's rpcJSON response type not found — it was renamed or restructured" };
  if (!list) return { error: "listDir's entries type not found — it was renamed or restructured" };
  const fields = (block) => [...block.matchAll(/(\w+)\??\s*:/g)].map((m) => m[1]);
  return { stat: fields(stat[1]), entry: fields(list[1]) };
}

const GUEST = guestFileShapes();

// ── THE PATH RULES, COUNTED FROM apps/api ───────────────────────────────────
//
// sanitiseGuestPath is what stands between a `path=` query parameter and the
// guest filesystem, and platinum-stub.mjs reimplements it. The stub enforces
// the two rules that exist today — no NUL, no `..` segment — but nothing here
// would notice apps/api ADDING a third. The env would then send paths the real
// route refuses, and the first sign of it would be a tool failing in
// production.
//
// So the rules are counted from the source. A new one fails this and says to go
// and implement it, rather than being discovered later.
function guestPathRules() {
  let src;
  try { src = readFileSync(SANDBOXES_SRC, "utf8"); }
  catch (e) { return { error: `cannot read ${SANDBOXES_SRC}: ${e.message}` }; }
  const fn = /function sanitiseGuestPath\([\s\S]*?\n\}/.exec(src);
  if (!fn) return { error: "sanitiseGuestPath not found — it was renamed or restructured" };
  const throws = [...fn[0].matchAll(/throw new Error\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  return { throws };
}

const RULES = guestPathRules();

const HERE = new URL(".", import.meta.url).pathname;
const ROOT = "/tmp/platinum-env-work";
const PORT = 7129;
await rm(ROOT, { recursive: true, force: true });
await mkdir(`${ROOT}/w`, { recursive: true });

// A stale stub from a crashed run would hold the port and the new spawn would
// fail silently (stdio is ignored) — every claim below would then run against
// OLD stub code. Measured: one leaked stub made 3 claims fail for the wrong
// reason. Busy port = named failure, not a run against the wrong server.
const busy = await new Promise((r) => { const sock = createConnection({ host: "127.0.0.1", port: PORT }); sock.once("connect", () => { sock.destroy(); r(true); }); sock.once("error", () => r(false)); });
if (busy) { console.log(`  FAIL  port ${PORT} is already in use — a leaked platinum-stub from an earlier run; kill it (lsof -i :${PORT}) and rerun`); process.exit(1); }
const stub = spawn(process.execPath, [`${HERE}platinum-stub.mjs`], {
  env: { ...process.env, PORT: String(PORT), SANDBOX_KEY: "pt_live_envkey", SANDBOX_ID: "sbx_env", WORK_ROOT: ROOT },
  stdio: "ignore",
});
await new Promise((r) => setTimeout(r, 500));

let bad = 0;
const check = watchClaims((n, c, d = "") => { if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });
const onDisk = (p) => readFile(`${ROOT}/w/${p}`, "utf8");

const env = platinumExecutionEnv({ apiUrl: `http://127.0.0.1:${PORT}`, key: "pt_live_envkey", sandboxId: "sbx_env", cwd: `${ROOT}/w` });
const ctx = { env };
const run = (tool, id, input) => tool.execute(id, input, undefined, undefined, ctx);

// ── the env's own semantics over the native routes ──────────────────────────
let r = await env.writeFile("src/app.py", "one\ntwo\nthree\n");
check("writeFile goes through PUT /files", r.ok, JSON.stringify(r));
check("and lands on the sandbox filesystem", (await onDisk("src/app.py")).includes("two"));
// THE PUT BODY IS THE FILE. Platinum's handler reads c.req.arrayBuffer() and
// writes it verbatim; it has no {content} field. The client used to send one,
// and the stub used to accept one — so 55 claims passed against a contract the
// platform does not have, and on dev every written file held a JSON envelope.
{
  const src = readFileSync(SANDBOXES_SRC, "utf8");
  const put = /\.put\('\/:id\/files',[\s\S]*?\n  \}\)/.exec(src)?.[0] ?? "";
  check("PLATINUM'S PUT /files WRITES THE REQUEST BODY VERBATIM — read from its source, not assumed",
    put.includes("c.req.arrayBuffer()") && !/body\.content|json\(\)\.content/.test(put), put ? `handler found; arrayBuffer=${put.includes("arrayBuffer")}` : "handler not found in sandboxes.ts");
  const envelope = await fetch(`http://127.0.0.1:${PORT}/v1/sandboxes/sbx_env/files?path=${encodeURIComponent(`${ROOT}/w/env.txt`)}`,
    { method: "PUT", headers: { authorization: "Bearer pt_live_envkey", "content-type": "application/json" }, body: '{"content":"x"}' });
  check("and so does the stub: a literal {\"content\":\"x\"} body is stored as those 15 bytes, not unwrapped",
    envelope.status === 200 && (await onDisk("env.txt")) === '{"content":"x"}', JSON.stringify(await onDisk("env.txt").catch(() => null)));
  const every = new Uint8Array(256); for (let i = 0; i < 256; i++) every[i] = i;
  const w = await env.writeFile("bin/all.bin", every);
  const back = await env.readBinaryFile("bin/all.bin");
  check("a write of bytes 0x00..0xFF reads back identical — bytes go as bytes, never through a text decoder",
    w.ok && back.ok && back.value.length === 256 && back.value.every((b, i) => b === i), `wrote ok=${w.ok}; read ${back.value?.length} bytes, first mismatch at ${back.value ? [...back.value].findIndex((b, i) => b !== i) : "n/a"}`);
}
r = await env.fileInfo("src/app.py");
check("fileInfo maps {is_dir,size,mtime} to pi's {kind,size,mtimeMs}",
  r.ok && r.value.kind === "file" && r.value.size > 0, JSON.stringify(r).slice(0, 100));
r = await env.exists("src/nope.py");
check("exists maps a 404 to false, not an error", r.ok && r.value === false, JSON.stringify(r));
r = await env.listDir("src");
check("listDir maps entries to pi's shape", r.ok && r.value.some((e) => e.name === "app.py" && e.kind === "file"), JSON.stringify(r).slice(0, 100));
// A RANGED READ IS BYTES, AND ANSWERS 206. Platinum's GET /files with offset or
// limit calls readFileRange({offset, length: limit}) under a byte cap and
// replies 206. readTextLines used to ask for limit=maxLines and accept only
// 200 — on dev that was a FileError for a five-line file. The stub used to
// slice lines and say 200, so the suite could not know.
{
  const src = readFileSync(SANDBOXES_SRC, "utf8");
  const ranged = /readFileRange\(sbx\.id, path, \{ offset, length: limit \}\)[\s\S]{0,400}?status: 206/.exec(src);
  check("PLATINUM'S RANGED GET /files IS A BYTE WINDOW THAT ANSWERS 206 — read from its source", !!ranged && /MAX_RANGE_READ_BYTES/.test(src));
  await env.writeFile("lines.txt", "one\ntwo\nthree\nfour\nfive\n");
  const win = await fetch(`http://127.0.0.1:${PORT}/v1/sandboxes/sbx_env/files?path=${encodeURIComponent(`${ROOT}/w/lines.txt`)}&limit=3`, { headers: { authorization: "Bearer pt_live_envkey" } });
  check("and so is the stub's: limit=3 is three BYTES, status 206", win.status === 206 && (await win.text()) === "one", `status ${win.status}`);
  const two = await env.readTextLines("lines.txt", { maxLines: 2 });
  check("readTextLines(maxLines: 2) on a five-line file is exactly the first two LINES",
    two.ok && Array.isArray(two.value) && two.value.length === 2 && two.value[0] === "one" && two.value[1] === "two", JSON.stringify(two).slice(0, 120));
}
r = await env.readBinaryFile("src/app.py");
check("readBinaryFile returns bytes from the raw route", r.ok && r.value instanceof Uint8Array && r.value.length > 0);
r = await env.readTextFile("src/missing.py");
check("a missing file is a not_found FileError", !r.ok && r.error.code === "not_found", JSON.stringify(r).slice(0, 90));

// The ops with no route, through the sandbox's own shell.
r = await env.createDir("pkg/deep");
check("createDir (via exec mkdir -p) works", r.ok, JSON.stringify(r));
r = await env.appendFile("src/app.py", "four\n");
check("appendFile (via exec >>) appends", r.ok && (await onDisk("src/app.py")).endsWith("four\n"), JSON.stringify(r));
r = await env.renameFile("src/app.py", "src/main.py");
check("renameFile (via exec mv) moves", r.ok && (await onDisk("src/main.py")).includes("one"));
r = await env.exec("exit 7");
check("exec: a non-zero exit is a RESULT with exit_code mapped", r.ok && r.value.exitCode === 7, JSON.stringify(r).slice(0, 90));

// ── pi's unmodified tools ───────────────────────────────────────────────────
const before = await onDisk("src/main.py");
const res = await run(createEditTool(), "e1", { path: "src/main.py", edits: [{ oldText: "two", newText: "TWO" }] });
const after = await onDisk("src/main.py");
check("pi's edit tool changed exactly the target line over Platinum's API",
  after.includes("TWO") && after.replace("TWO", "two") === before, JSON.stringify(after));
check("the edit returned a diff", typeof res?.details?.diff === "string" && res.details.diff.length > 0);
const rd = await run(createReadTool(), "r1", { path: "src/main.py" });
check("pi's read tool works over Platinum", JSON.stringify(rd).includes("TWO"));
await run(createWriteTool(), "w1", { path: "gen/out.txt", content: "made by pi" });
check("pi's write tool creates parents over Platinum", (await onDisk("gen/out.txt")) === "made by pi");
// Caught, not awaited bare: pi's bash tool THROWS on a non-zero exit, and an
// uncaught throw ends the process without printing a FAIL — a regression would
// look like a crash rather than a failing claim. Verified by mutation: dropping
// the `cd` from exec makes this fail here instead of aborting the run.
let b;
try { b = await run(createBashTool(), "b1", { command: "cat gen/out.txt" }); }
catch (e) { b = { threw: String(e?.message ?? e) }; }
check("pi's bash tool runs over Platinum's /exec, in the env's cwd",
  JSON.stringify(b).includes("made by pi"), JSON.stringify(b).slice(0, 140));

// ── ROUND TRIPS on this side too ────────────────────────────────────────────
// Same five producers, same question: does what this returns come back in?
{
  await env.writeFile("trip/a.txt", "round trip\n");

  const abs = await env.absolutePath("trip/a.txt");
  const viaAbs = abs.ok ? await env.readTextFile(abs.value) : { ok: false };
  check("absolutePath's output reads back", viaAbs.ok && viaAbs.value.includes("round trip"),
    `${JSON.stringify(abs).slice(0, 70)} -> ${JSON.stringify(viaAbs).slice(0, 70)}`);

  const joined = await env.joinPath(["trip", "a.txt"]);
  const viaJoin = joined.ok ? await env.readTextFile(joined.value) : { ok: false };
  check("joinPath's output reads back", viaJoin.ok && viaJoin.value.includes("round trip"),
    `${JSON.stringify(joined).slice(0, 70)} -> ${JSON.stringify(viaJoin).slice(0, 70)}`);

  const listed = await env.listDir("trip");
  const entry = listed.ok ? listed.value.find((e) => e.name === "a.txt") : null;
  const viaList = entry ? await env.readTextFile(entry.path) : { ok: false };
  check("a listDir entry's `path` reads back", viaList.ok && viaList.value.includes("round trip"),
    `${JSON.stringify(entry).slice(0, 80)} -> ${JSON.stringify(viaList).slice(0, 70)}`);

  const tmpDir = await env.createTempDir("rt");
  check("createTempDir returns an absolute path too", tmpDir.ok && tmpDir.value.startsWith("/"),
    JSON.stringify(tmpDir).slice(0, 90));
  const inTmp = tmpDir.ok ? await env.writeFile(`${tmpDir.value}/f.txt`, "in temp\n") : { ok: false };
  const readTmp = inTmp.ok ? await env.readTextFile(`${tmpDir.value}/f.txt`) : { ok: false };
  check("createTempDir's path can be written to and read back",
    readTmp.ok && readTmp.value.includes("in temp"),
    `${JSON.stringify(tmpDir).slice(0, 70)} -> ${JSON.stringify(readTmp).slice(0, 70)}`);

  // Absolute, and claimed separately because the round trip cannot see it: a
  // relative temp path still reads back through this env, so only the contract
  // distinguishes them. A temp file's location must not depend on the caller's
  // cwd — that is the whole point of asking the env for one.
  const tmpFile = await env.createTempFile({ prefix: "rt", suffix: ".txt" });
  check("createTempFile returns an ABSOLUTE path, not one relative to cwd",
    tmpFile.ok && tmpFile.value.startsWith("/"), JSON.stringify(tmpFile).slice(0, 90));
  const wrote = tmpFile.ok ? await env.writeFile(tmpFile.value, "temp file\n") : { ok: false };
  const readBack = wrote.ok ? await env.readTextFile(tmpFile.value) : { ok: false };
  check("createTempFile's path can be written to and read back",
    readBack.ok && readBack.value.includes("temp file"),
    `${JSON.stringify(tmpFile).slice(0, 70)} -> ${JSON.stringify(readBack).slice(0, 70)}`);
}

// ── absolute paths on this side too ─────────────────────────────────────────
// Same gap, same reason: pi's edit tool feeds canonicalPath's ABSOLUTE result
// straight back into read and write. The Platinum env resolves a relative path
// against cwd and strips the prefix from an absolute one; neither direction had
// a claim.
{
  await env.writeFile("abs/here.txt", "by relative path\n");
  const viaAbs = await env.readTextFile(`${ROOT}/w/abs/here.txt`);
  check("an absolute path inside the sandbox reads the same file as the relative one",
    viaAbs.ok && viaAbs.value.includes("by relative path"), JSON.stringify(viaAbs).slice(0, 120));
  const w = await env.writeFile(`${ROOT}/w/abs/written.txt`, "by absolute path\n");
  const back = await env.readTextFile("abs/written.txt");
  check("and a write through an absolute path lands where the relative read finds it",
    w.ok && back.ok && back.value.includes("by absolute path"), JSON.stringify(back).slice(0, 120));
  const canon = await env.canonicalPath("abs/here.txt");
  check("canonicalPath returns an absolute path, which is why this matters",
    canon.ok && canon.value.startsWith("/"), JSON.stringify(canon).slice(0, 120));
  const round = await env.readTextFile(canon.value);
  check("and feeding its own output back in reads the file — the pi edit-tool sequence",
    round.ok && round.value.includes("by relative path"), JSON.stringify(round).slice(0, 120));
}

// ── the read paths that had no error claim ──────────────────────────────────
// Found by npm run conditions. readTextFile's failure is claimed above;
// readTextLines and readBinaryFile have the SAME check and neither was reached,
// and fileInfo was only ever tested on success. These are the calls pi's own
// tools make — a read that returns ok(undefined) instead of a FileError hands
// the edit tool a file it thinks is empty, and it writes that back.
{
  const lines = await env.readTextLines("src/main.py", { maxLines: 2 });
  check("readTextLines returns the file's lines", lines.ok && Array.isArray(lines.value) && lines.value.length > 0,
    JSON.stringify(lines).slice(0, 110));
  const missingLines = await env.readTextLines("src/no-such-file.py");
  check("and a missing file is a not_found FileError, not an empty list",
    !missingLines.ok && missingLines.error?.code === "not_found", JSON.stringify(missingLines).slice(0, 120));

  const missingBin = await env.readBinaryFile("src/no-such-file.py");
  check("readBinaryFile fails the same way rather than returning zero bytes",
    !missingBin.ok && missingBin.error?.code === "not_found", JSON.stringify(missingBin).slice(0, 120));

  const missingInfo = await env.fileInfo("src/no-such-file.py");
  check("fileInfo on a missing path is a not_found FileError — pi's edit tool gates on this",
    !missingInfo.ok && missingInfo.error?.code === "not_found", JSON.stringify(missingInfo).slice(0, 120));
}

// ── stderr reaches the tool, not only stdout ────────────────────────────────
// Found by npm run conditions: the `if (r.stderr && options.onStderr)` branch
// had no claim behind it on this path. Its SIBLING was a real bug — pi's bash
// tool reads what a command printed from onStdout/onStderr, not from the
// returned value, and without the callbacks it reported "(no output)" for a
// command that had produced output and exited 0. stderr has the same shape and
// was never exercised here, only on the daemon path.
{
  const seen = { out: [], err: [] };
  const r = await env.exec("echo to-stdout; echo to-stderr >&2", {
    onStdout: (c) => seen.out.push(c),
    onStderr: (c) => seen.err.push(c),
  });
  check("exec delivers stdout through onStdout", r.ok && seen.out.join("").includes("to-stdout"),
    JSON.stringify(seen).slice(0, 120));
  check("AND stderr through onStderr — pi's bash tool reads both from the callbacks",
    seen.err.join("").includes("to-stderr"), JSON.stringify(seen).slice(0, 120));
  // A command that writes only to stderr must not look like it printed nothing.
  const seen2 = { err: [] };
  const only = await env.exec("echo just-stderr >&2", { onStderr: (c) => seen2.err.push(c) });
  check("a command whose only output is stderr is not reported as silent",
    only.ok && seen2.err.join("").includes("just-stderr"), JSON.stringify(seen2).slice(0, 120));
}

// ── the scope refusal still holds underneath all of it ──────────────────────
const other = platinumExecutionEnv({ apiUrl: `http://127.0.0.1:${PORT}`, key: "pt_live_envkey", sandboxId: "sbx_someone_else", cwd: `${ROOT}/w` });
r = await other.readTextFile("src/main.py");
check("a key scoped to another sandbox is refused, as a FileError not a throw",
  !r.ok && r.error.code === "permission_denied", JSON.stringify(r).slice(0, 100));

// ── the path rules the stub must keep up with ──────────────────────────────
check("apps/api's sanitiseGuestPath is readable and still parses", !RULES.error, RULES.error ?? "");
if (!RULES.error) {
  // Two rules today. The count is the tripwire: a third means the stub — and
  // very likely execenv.platinum.js — has to learn it.
  check("apps/api enforces exactly the two path rules this stub implements",
    RULES.throws.length === 2, JSON.stringify(RULES.throws));
  check("and they are still the NUL and .. rules, not two different ones",
    RULES.throws.some((t) => /NUL/i.test(t)) && RULES.throws.some((t) => /\.\./.test(t)),
    JSON.stringify(RULES.throws));

  // The stub must actually enforce them, not merely be believed to.
  const refuse = async (path) => {
    const r = await fetch(`http://127.0.0.1:${PORT}/v1/sandboxes/sbx_env/files/stat?path=${encodeURIComponent(path)}`,
      { headers: { authorization: "Bearer pt_live_envkey" } });
    return r.status;
  };
  check("the stub refuses a `..` segment with a 400, as the route does",
    (await refuse("../../etc/passwd")) === 400, String(await refuse("../../etc/passwd")));
  check("and refuses a NUL byte", (await refuse("ok\u0000bad")) === 400, String(await refuse("ok\u0000bad")));
}

// ── the claims coupled to apps/api's own declarations ──────────────────────
check("apps/api's guest file-op response types are readable and still parse",
  !GUEST.error, GUEST.error ?? "");

if (!GUEST.error) {
  // These four names are what execenv.platinum.js reads. A rename on the
  // platform side turns every directory into a file, silently.
  for (const f of ["ok", "size", "is_dir", "mtime"]) {
    check(`statFile still returns \`${f}\`, which the env maps`, GUEST.stat.includes(f), JSON.stringify(GUEST.stat));
  }
  for (const f of ["name", "is_dir"]) {
    check(`a listDir entry still has \`${f}\``, GUEST.entry.includes(f), JSON.stringify(GUEST.entry));
  }
  // And the stub must answer with the same field names it is imitating,
  // otherwise every claim above it is testing a fiction.
  const raw = await fetch(`http://127.0.0.1:${PORT}/v1/sandboxes/sbx_env/files/stat?path=${encodeURIComponent(`${ROOT}/w/src/main.py`)}`,
    { headers: { authorization: "Bearer pt_live_envkey" } });
  const body = await raw.json();
  const missing = GUEST.stat.filter((f) => f !== "error" && !Object.prototype.hasOwnProperty.call(body, f));
  check("THE STUB ANSWERS WITH THE PLATFORM'S OWN FIELD NAMES, not names of its own",
    missing.length === 0, `missing from the stub: ${JSON.stringify(missing)} — stub sent ${JSON.stringify(Object.keys(body))}`);
}

stub.kill();
// ── when the platform answers with a failure ────────────────────────────────
// Every claim above runs against a stub that works. The branches that read the
// status and turn it into an error had never run, and the failure mode they
// prevent is the quiet one: a non-200 turned into `{ok: true, stdout: ""}` is a
// command that "printed nothing and worked" as far as the model can tell, and
// it will carry on building on top of it.
//
// pi's ExecutionError kinds are a short list — a 403 is "unknown" to pi — so the
// platform's own status and code have to travel in the MESSAGE or the transcript
// keeps no machine-readable reason at all.
{
  let reply = { status: 200, body: {} };
  const api = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => { b += c; });
    req.on("end", () => { res.writeHead(reply.status, { "content-type": "application/json" }); res.end(JSON.stringify(reply.body)); });
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  const sick = platinumExecutionEnv({ apiUrl: `http://127.0.0.1:${api.address().port}`, key: "k", sandboxId: "sbx", cwd: "/work" });

  reply = { status: 403, body: { error: "forbidden: this API key is scoped to another sandbox", code: "sandbox_scope" } };
  const refused = await sick.exec("echo hi", {});
  check("a 403 from the platform is an ERROR, not a command that printed nothing and worked",
    refused.ok === false, JSON.stringify(refused).slice(0, 120));
  check("and the status and the platform's own code travel in the message",
    /403/.test(refused.error.message) && /sandbox_scope/.test(refused.error.message), String(refused.error.message));
  check("which matters because pi has no kind for a scope refusal — it arrives as `unknown`",
    refused.error.code === "unknown", String(refused.error.code));

  reply = { status: 504, body: { error: "exec timed out (host agent not responding)", code: "exec_timeout" } };
  const timedOut = await sick.exec("sleep 99", {});
  check("a 504 exec_timeout is mapped to pi's TIMEOUT kind, not lumped in with unknown",
    timedOut.ok === false && timedOut.error.code === "timeout", JSON.stringify(timedOut).slice(0, 120));

  reply = { status: 500, body: { error: "boom" } };
  const broke = await sick.exec("echo hi", {});
  check("a 500 keeps the platform's message rather than inventing one",
    broke.ok === false && /boom/.test(broke.error.message), String(broke.error?.message));

  // canonicalPath is the one whose failure would be silent AND load-bearing:
  // its answer is what every later absolute path is built from.
  const canon = await sick.canonicalPath("a/b");
  check("canonicalPath FAILS rather than handing back a path it never resolved",
    canon.ok === false && canon.error.name === "FileError", JSON.stringify(canon).slice(0, 120));

  // And a read, so an unreadable file is not an empty one.
  const read = await sick.readTextFile("a/b");
  check("a failed read is an error, not empty content",
    read.ok === false, JSON.stringify(read).slice(0, 120));

  api.close();
}

console.log(bad ? `\n  ${bad} failure(s)` : "\n  pi's own tools run over Platinum's API");
process.exit(bad ? 1 : 0);
