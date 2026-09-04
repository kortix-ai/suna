// pi's REAL edit tool, driven against the remote workspace.
//
// The point of implementing ExecutionEnv is createEditTool: {path, edits:
// [{oldText, newText}]} instead of making the model reproduce a whole file to
// change one line. This drives the actual tool from pi against the actual
// daemon, in-process, and asserts the file really changed.
// Read by test/all.sh. The suite's own tail line catches a section that ran
// and produced nothing; it cannot catch an exit partway through, which skips
// the tail entirely. This is the number that check compares against.
// EXPECTED_PASSES=37

import { createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-agent-core";
import { remoteExecutionEnv } from "../src/execenv.js";
import { rm, mkdir, readFile } from "node:fs/promises";
import { watchClaims } from "../../tools/crash-reporter.mjs";

process.env.TOKEN = "env-token";
process.env.WORK_ROOT = "/tmp/execenv-work";
const PORT = 7126;
const { createDaemon } = await import("../daemon/server.js");
await rm(process.env.WORK_ROOT, { recursive: true, force: true });
await mkdir(process.env.WORK_ROOT, { recursive: true });
const server = createDaemon();
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

let bad = 0;
const check = watchClaims((n, c, d = "") => { if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });

// The opId prefix is the tool call id in the worker; here it only has to be
// present, because a missing one is refused — the last claim in this file.
const env = remoteExecutionEnv({ base: `http://127.0.0.1:${PORT}`, token: "env-token", sessionId: "s", cwd: "/work", opId: "call_env" });
const ctx = { env };
const onDisk = (p) => readFile(`${process.env.WORK_ROOT}/s/${p}`, "utf8");

// ── the env itself ──────────────────────────────────────────────────────────
let r = await env.writeFile("src/app.py", "line one\nline two\nline three\n");
check("writeFile succeeds through the workspace", r.ok, JSON.stringify(r));
check("the file is really on the workspace disk", (await onDisk("src/app.py")).includes("line two"));
r = await env.readTextFile("src/app.py");
check("readTextFile round-trips", r.ok && r.value.includes("line three"), JSON.stringify(r).slice(0, 90));
r = await env.exists("src/app.py");
check("exists is true for a written file", r.ok && r.value === true, JSON.stringify(r));
r = await env.exists("src/nope.py");
check("exists is FALSE, not an error, for a missing file", r.ok && r.value === false, JSON.stringify(r));
r = await env.fileInfo("src/app.py");
// pi's FileInfo is {name, path, kind, size, mtimeMs}. Getting `kind` wrong is
// not cosmetic: the edit tool refuses anything that is not "file" or "symlink".
check("fileInfo reports pi's shape, with kind as a string",
  r.ok && r.value.kind === "file" && r.value.size > 0 && typeof r.value.mtimeMs === "number",
  JSON.stringify(r).slice(0, 110));
r = await env.listDir("src");
check("listDir lists children with a kind", r.ok && r.value.some((e) => e.name === "app.py" && e.kind === "file"), JSON.stringify(r).slice(0, 90));
r = await env.createDir("pkg/sub");
check("createDir is recursive", r.ok, JSON.stringify(r));
r = await env.appendFile("src/app.py", "line four\n");
check("appendFile appends", r.ok && (await onDisk("src/app.py")).includes("line four"));
r = await env.exec("echo hi");
check("exec returns stdout and an exit code", r.ok && r.value.stdout.includes("hi") && r.value.exitCode === 0, JSON.stringify(r).slice(0, 90));
r = await env.exec("exit 3");
check("a non-zero exit is a RESULT, not an error", r.ok && r.value.exitCode === 3, JSON.stringify(r).slice(0, 90));
r = await env.readTextFile("src/missing.py");
// pi's FileError carries a snake_case `code`, not a `kind`. The tools branch on
// it, so the wrong spelling degrades silently into "unknown".
check("a missing file is a not_found FileError, not a throw",
  !r.ok && r.error.code === "not_found" && r.error instanceof Error,
  JSON.stringify(r).slice(0, 110));

// ── pi's OWN tools, unmodified ──────────────────────────────────────────────
const edit = createEditTool();
const before = await onDisk("src/app.py");
// pi's HARNESS tools take the context as the FIFTH argument —
// (toolCallId, input, signal, onUpdate, ctx) — where an AgentTool takes four.
// That difference is exactly what an adapter has to bridge.
const res = await edit.execute("op-edit-1", { path: "src/app.py", edits: [{ oldText: "line two", newText: "LINE TWO CHANGED" }] }, undefined, undefined, ctx);
const after = await onDisk("src/app.py");
check("pi's edit tool changed exactly the target line",
  after.includes("LINE TWO CHANGED") && after.includes("line one") && after.includes("line three"),
  JSON.stringify(after));
check("the untouched lines are byte-identical",
  after.replace("LINE TWO CHANGED", "line two") === before, JSON.stringify(after));
check("the edit returns a diff, which is what a UI shows",
  typeof res?.details?.diff === "string" && res.details.diff.length > 0, JSON.stringify(res?.details ?? {}).slice(0, 100));

const readTool = createReadTool();
const rr = await readTool.execute("op-read-1", { path: "src/app.py" }, undefined, undefined, ctx);
check("pi's read tool works against the workspace",
  JSON.stringify(rr).includes("LINE TWO CHANGED"), JSON.stringify(rr).slice(0, 120));

const writeTool = createWriteTool();
await writeTool.execute("op-write-1", { path: "fresh/new.txt", content: "written by pi" }, undefined, undefined, ctx);
check("pi's write tool creates parent directories", (await onDisk("fresh/new.txt")) === "written by pi");

// pi's bash tool reads a command's output from the onStdout/onStderr CALLBACKS,
// not from the returned stdout. This file tested edit, read and write and never
// bash, so an env that ignored the callbacks reported "(no output)" for every
// successful command and nothing here noticed. Found on the Platinum env; the
// daemon env had it too.
const { createBashTool } = await import("@earendil-works/pi-agent-core");
const bres = await createBashTool().execute("op-bash-1", { command: "cat src/app.py" }, undefined, undefined, ctx);
check("pi's bash tool receives the command's OUTPUT, not '(no output)'",
  JSON.stringify(bres).includes("LINE TWO CHANGED") && !JSON.stringify(bres).includes("no output"),
  JSON.stringify(bres).slice(0, 120));
const bfail = await createBashTool().execute("op-bash-2", { command: "echo to-stderr >&2; exit 0" }, undefined, undefined, ctx);
check("stderr reaches the tool too", JSON.stringify(bfail).includes("to-stderr"), JSON.stringify(bfail).slice(0, 120));

// ── ROUND TRIPS: what a function returns must be what its sibling accepts ───
// The symlink bug was exactly this shape — canonicalPath produced a path
// readTextFile then rejected — and five more producers had never been fed back
// into a consumer at all. Each is an ExecutionEnv method pi's tools call.
{
  await env.writeFile("trip/a.txt", "round trip\n");

  const abs = await env.absolutePath("trip/a.txt");
  const viaAbs = abs.ok ? await env.readTextFile(abs.value) : { ok: false, error: abs.error };
  check("absolutePath's output reads back", viaAbs.ok && viaAbs.value.includes("round trip"),
    `${JSON.stringify(abs).slice(0, 70)} -> ${JSON.stringify(viaAbs).slice(0, 70)}`);

  const joined = await env.joinPath(["trip", "a.txt"]);
  const viaJoin = joined.ok ? await env.readTextFile(joined.value) : { ok: false };
  check("joinPath's output reads back", viaJoin.ok && viaJoin.value.includes("round trip"),
    `${JSON.stringify(joined).slice(0, 70)} -> ${JSON.stringify(viaJoin).slice(0, 70)}`);

  const listed = await env.listDir("trip");
  const entry = listed.ok ? listed.value.find((e) => e.name === "a.txt") : null;
  const viaList = entry ? await env.readTextFile(entry.path) : { ok: false };
  check("a listDir entry's `path` reads back — it is what a model is shown and then uses",
    viaList.ok && viaList.value.includes("round trip"),
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

// ── absolute paths, which is what pi's own tools hand back ──────────────────
// Found by npm run conditions: rel()'s absolute branch had no claim. It is not
// an edge case — pi's edit tool calls canonicalPath, which returns an ABSOLUTE
// path, and then reads and writes with that. If the cwd prefix is not stripped
// the daemon sees a path outside its session directory and refuses, so every
// edit after a canonicalPath fails.
{
  await env.writeFile("abs/here.txt", "by relative path\n");
  const viaAbs = await env.readTextFile("/work/abs/here.txt");
  check("an absolute path inside the workspace reads the same file as the relative one",
    viaAbs.ok && viaAbs.value.includes("by relative path"), JSON.stringify(viaAbs).slice(0, 120));

  const w = await env.writeFile("/work/abs/written.txt", "by absolute path\n");
  const back = await env.readTextFile("abs/written.txt");
  check("and a write through an absolute path lands where the relative read finds it",
    w.ok && back.ok && back.value.includes("by absolute path"), JSON.stringify(back).slice(0, 120));

  const info = await env.fileInfo("/work/abs/here.txt");
  check("fileInfo takes one too — canonicalPath's output goes straight back in",
    info.ok && info.value.kind === "file", JSON.stringify(info).slice(0, 120));

  // The other half: an absolute path OUTSIDE the workspace must not resolve.
  // rel() does not guess at containment, the daemon enforces it — this claims
  // the env does not smuggle one past it.
  const outside = await env.readTextFile("/etc/hosts");
  check("an absolute path outside the workspace is refused, not silently rebased",
    !outside.ok, JSON.stringify(outside).slice(0, 120));
}

// ── the read paths that had no failure claim, on this side too ──────────────
// The Platinum env had exactly this gap and it is closed there; the daemon env
// has the same three functions with the same unclaimed checks. Parity is the
// whole point of having two backends — a guarantee that holds on one and not
// the other is not a guarantee.
//
// The danger is not that these throw. It is that without the check they return
// a PLAUSIBLE EMPTY VALUE: an empty line array, zero bytes, an undefined
// FileInfo. Nothing downstream can tell that from a real answer, and pi's edit
// tool writes back what it believes it read.
{
  const lines = await env.readTextLines("src/app.py", { maxLines: 2 });
  check("readTextLines returns the file's lines", lines.ok && Array.isArray(lines.value) && lines.value.length > 0,
    JSON.stringify(lines).slice(0, 110));
  const missingLines = await env.readTextLines("src/nowhere.py");
  check("and a missing file is a FileError, not an empty list",
    !missingLines.ok && missingLines.error?.code, JSON.stringify(missingLines).slice(0, 120));
  const missingBin = await env.readBinaryFile("src/nowhere.py");
  check("readBinaryFile fails rather than returning zero bytes",
    !missingBin.ok && missingBin.error?.code, JSON.stringify(missingBin).slice(0, 120));
  const missingInfo = await env.fileInfo("src/nowhere.py");
  check("fileInfo on a missing path is a FileError — pi's edit tool gates on `kind`",
    !missingInfo.ok && missingInfo.error?.code, JSON.stringify(missingInfo).slice(0, 120));
}

// ── a daemon that answers with an ERROR ─────────────────────────────────────
// Found by mutate-guards: removing the `!res.ok` throw in execenv.js broke no
// claim. Every test so far has had a healthy daemon, so a 500 — a daemon out of
// disk, a proxy in the way — went down a path nothing had ever executed.
{
  const { createServer } = await import("node:http");
  const broken = createServer((_q, s) => { s.writeHead(500, { "content-type": "text/plain" }); s.end("daemon exploded"); });
  await new Promise((r) => broken.listen(PORT + 40, "127.0.0.1", r));
  const sick = remoteExecutionEnv({ base: `http://127.0.0.1:${PORT + 40}`, token: "env-token", sessionId: "s", cwd: "/work", opId: "call_sick" });

  const readRes = await sick.readTextFile("anything");
  check("a 5xx from the daemon is a FileError, not a silent empty read",
    !readRes.ok && /500/.test(String(readRes.error?.message ?? readRes.error)),
    JSON.stringify(readRes).slice(0, 140));
  const execRes = await sick.exec("echo hi");
  check("and a 5xx on exec is an ExecutionError, not a command that printed nothing",
    !execRes.ok, JSON.stringify(execRes).slice(0, 140));
  await new Promise((r) => broken.close(r));
}

// ── the prefix is not optional ──────────────────────────────────────────────
// A session-wide prefix collides across turns: seq restarts with each env, so
// the first op of every turn shares an id and the daemon answers the later ones
// from the earlier one's entry. Construction refuses rather than allowing it.
let threw = "";
try { remoteExecutionEnv({ base: `http://127.0.0.1:${PORT}`, token: "env-token", sessionId: "s", cwd: "/work" }); }
catch (e) { threw = String(e?.message ?? e); }
check("an env built without an op id prefix is refused, not silently session-scoped",
  /opId/.test(threw), threw || "constructed without complaint");

server.close();
console.log(bad ? `\n  ${bad} failure(s)` : "\n  pi's own tools run against the remote workspace");
process.exit(bad ? 1 : 0);
