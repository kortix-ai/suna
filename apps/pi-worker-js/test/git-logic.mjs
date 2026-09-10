// THE PROJECT'S FILES, IN THE CELL. A cell's workspace was empty and stayed
// empty: no checkout, so no skills, no AGENTS.md, nothing in the Files panel,
// and `/file/status` answered `[]` because there was no git. isomorphic-git
// over the cell's in-memory tree, cloning through the Kortix git proxy with
// the session's own token.
// EXPECTED_PASSES=26
import { DatabaseSync } from "node:sqlite";
import { watchClaims } from "../../tools/crash-reporter.mjs";
import { makeCell, installWorkerGlobals } from "./cell-harness.mjs";
installWorkerGlobals();
let bad = 0;
const check = watchClaims((n, c, d = "") => { if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });
const { cellFs, cellExecutionEnv, CELL_CWD } = await import("../src/execenv.cell.js");
const { git, gitFs, gitHttp, toBytes, projectGitUrl, gitAuth, isCheckedOut, cloneProject, workingStatus } = await import("../src/cell-git.js");
const { AgentCell } = await import("../dist/worker.js");

const makeSql = (db) => ({ exec(q, ...a) { const t = q.trim(); if (/^(CREATE|INSERT|UPDATE|DELETE)/i.test(t)) { const st = db.prepare(t); a.length ? st.run(...a) : st.run(); return { toArray: () => [], [Symbol.iterator]: function* () {} }; } const rows = db.prepare(t).all(...a); return { toArray: () => rows, [Symbol.iterator]: function* () { yield* rows; } }; } });
const db = new DatabaseSync(":memory:");
const sql = makeSql(db);

// ── bytes ──
// A VIEW IS NOT ITS BUFFER. `new Uint8Array(data.buffer)` takes the whole
// underlying ArrayBuffer from offset 0 — for a Buffer sliced out of a pool
// that is somebody else's bytes. It wrote a git index whose magic read
// `/\0\0\0` instead of `DIRC` and every commit failed (2026-09-10).
{
  const backing = new Uint8Array([9, 9, 68, 73, 82, 67, 9]);
  const view = backing.subarray(2, 6);
  check("toBytes copies a VIEW's own bytes, not the buffer behind it",
    new TextDecoder().decode(toBytes(view)) === "DIRC", JSON.stringify(Array.from(toBytes(view))));
  check("and handles a string, an ArrayBuffer and nothing",
    new TextDecoder().decode(toBytes("hi")) === "hi" && toBytes(new ArrayBuffer(3)).length === 3 && toBytes(undefined).length === 0, "");
}

// ── the url and the credential ──
check("the git origin is the API's own proxy, `/v1/git/<project>.git`",
  projectGitUrl("https://api.example.com/v1", "p1") === "https://api.example.com/v1/git/p1.git"
    && projectGitUrl("https://api.example.com", "p1") === "https://api.example.com/v1/git/p1.git", projectGitUrl("https://api.example.com", "p1"));
check("no api url or no project is no url — never a half-formed one",
  projectGitUrl("", "p1") === null && projectGitUrl("https://api.example.com", " ") === null, "");
check("the session's token is sent as basic auth, the shape git itself sends",
  gitAuth("kortix_pat_x").password === "kortix_pat_x" && gitAuth("kortix_pat_x").username === "x-access-token" && Object.keys(gitAuth("")).length === 0, "");

// ── the fs adapter, through a real repository ──
const cell = cellFs(sql); await cell.ready;
const fs = gitFs(cell.fs);
check("an unchecked-out workspace says so", (await isCheckedOut(cell.fs)) === false, "");
await git.init({ fs, dir: CELL_CWD, defaultBranch: "main" });
check("and after `git init` it says so", (await isCheckedOut(cell.fs)) === true, "");
await fs.promises.writeFile(`${CELL_CWD}/a.txt`, "hello\n");
await fs.promises.mkdir(`${CELL_CWD}/src`, { recursive: true });
await fs.promises.writeFile(`${CELL_CWD}/src/b.ts`, "export const b = 1;\n");
await git.add({ fs, dir: CELL_CWD, filepath: "a.txt" });
await git.add({ fs, dir: CELL_CWD, filepath: "src/b.ts" });
const sha = await git.commit({ fs, dir: CELL_CWD, message: "first", author: { name: "cell", email: "cell@kortix" } });
check("a commit is made over the cell's own tree — the index is written and read back",
  /^[0-9a-f]{40}$/.test(sha), sha);
check("the log carries it", (await git.log({ fs, dir: CELL_CWD })).length === 1, "");
check("and the branch is the one asked for", (await git.currentBranch({ fs, dir: CELL_CWD })) === "main", "");
check("a clean tree has no status", JSON.stringify(await workingStatus(cell)) === "[]", JSON.stringify(await workingStatus(cell)));
await fs.promises.writeFile(`${CELL_CWD}/a.txt`, "hello world\n");
await fs.promises.writeFile(`${CELL_CWD}/new.md`, "# new\n");
await fs.promises.unlink(`${CELL_CWD}/src/b.ts`);
const status = await workingStatus(cell);
const byPath = Object.fromEntries(status.map((f) => [f.path, f.status]));
check("a modified, an added and a deleted file each report themselves — the Files panel's own shape",
  byPath["a.txt"] === "modified" && byPath["new.md"] === "added" && byPath["src/b.ts"] === "deleted"
    && status.every((f) => "added" in f && "removed" in f), JSON.stringify(status));

// ── the errors isomorphic-git reads ──
{
  const missing = await fs.promises.readFile(`${CELL_CWD}/nope.txt`).catch((e) => e);
  check("a missing file throws ENOENT — isomorphic-git tests the CODE, and a plain Error reads as a broken repo",
    missing?.code === "ENOENT", String(missing?.code));
  const dir = await fs.promises.stat(`${CELL_CWD}/src`);
  check("stat answers a node-shaped record: isDirectory(), a mode and a size",
    dir.isDirectory() === true && dir.isFile() === false && typeof dir.mode === "number", JSON.stringify({ mode: dir.mode }));
  const again = await fs.promises.mkdir(`${CELL_CWD}/src`).catch((e) => e);
  check("mkdir on something that exists is EEXIST, unless recursive", again?.code === "EEXIST", String(again?.code));
}

// ── the http adapter ──
{
  const seen = [];
  const http = gitHttp(async (url, init) => {
    seen.push({ url, method: init.method, body: init.body ? new TextDecoder().decode(init.body) : null, auth: init.headers?.Authorization ?? null });
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, statusText: "OK", headers: { "content-type": "application/x-git-upload-pack-result" } });
  });
  async function* body() { yield new TextEncoder().encode("want "); yield new TextEncoder().encode("sha"); }
  const res = await http.request({ url: "https://api.example.com/v1/git/p.git/git-upload-pack", method: "POST", headers: { "content-type": "x" }, body: body() });
  check("the http client joins a chunked request body into one payload", seen[0].body === "want sha", JSON.stringify(seen[0].body));
  check("and answers the shape isomorphic-git reads: statusCode, headers, a byte body",
    res.statusCode === 200 && res.headers["content-type"].includes("git-upload-pack") && res.body[0].length === 3, JSON.stringify({ s: res.statusCode }));
}

// ── the cell's own checkout, without a repo to clone ──
{
  const h = makeCell(AgentCell, { KORTIX_SESSION_ID: "s", TOOLS_BACKEND: "cell" });
  const c = h.cell ?? h;
  const none = await c.ensureCheckout();
  check("a session with no repo url checks nothing out, and says why rather than throwing",
    none.ok === false && /no repo url/.test(none.reason), JSON.stringify(none));
  const files = await (await h.fetch("/file?path=&c=s")).json();
  check("its Files panel still answers — an empty workspace is a workspace", Array.isArray(files), JSON.stringify(files).slice(0, 80));
  const st = await (await h.fetch("/file/status?c=s")).json();
  check("and /file/status is empty rather than an error", JSON.stringify(st) === "[]", JSON.stringify(st));
}

// ── /file/status from a real checkout, through the route the panel calls ──
{
  const db2 = new DatabaseSync(":memory:");
  const h = makeCell(AgentCell, { KORTIX_SESSION_ID: "s2", TOOLS_BACKEND: "cell" });
  const c = h.cell ?? h;
  await (await h.fetch("/file?path=&c=s2")).json();          // makes the tree
  const f2 = gitFs(c.cellFs.fs);
  await git.init({ fs: f2, dir: CELL_CWD, defaultBranch: "main" });
  await f2.promises.writeFile(`${CELL_CWD}/tracked.txt`, "one\n");
  await git.add({ fs: f2, dir: CELL_CWD, filepath: "tracked.txt" });
  await git.commit({ fs: f2, dir: CELL_CWD, message: "c", author: { name: "c", email: "c@k" } });
  await f2.promises.writeFile(`${CELL_CWD}/tracked.txt`, "two\n");
  const served = await (await h.fetch("/file/status?c=s2")).json();
  check("GET /file/status answers git's own view once the workspace is a checkout",
    served.length === 1 && served[0].path === "tracked.txt" && served[0].status === "modified", JSON.stringify(served));
  const listed = await (await h.fetch("/file?path=&c=s2")).json();
  check("and the panel lists the checkout's files, .git marked ignored",
    listed.some((n) => n.name === "tracked.txt") && listed.find((n) => n.name === ".git")?.ignored === true, JSON.stringify(listed.map((n) => n.name)));
}

// ── the project's own instructions ──
{
  const h = makeCell(AgentCell, { KORTIX_SESSION_ID: "s3", TOOLS_BACKEND: "cell" });
  const c = h.cell ?? h;
  await (await h.fetch("/file?path=&c=s3")).json();
  check("no AGENTS.md, no instructions", (await c.projectInstructions()) === "", "");
  await c.cellFs.fs.writeFile(`${CELL_CWD}/AGENTS.md`, "# House rules\nAlways run the suite.\n");
  const text = await c.projectInstructions();
  check("AGENTS.md at the root of the checkout becomes the project's instructions, quoted",
    text.includes("Always run the suite.") && /AGENTS\.md/.test(text), JSON.stringify(text.slice(0, 90)));
  await c.cellFs.fs.rm(`${CELL_CWD}/AGENTS.md`, { force: true });
  await c.cellFs.fs.writeFile(`${CELL_CWD}/CLAUDE.md`, "Be brief.\n");
  check("CLAUDE.md is read the same way when AGENTS.md is absent", (await c.projectInstructions()).includes("Be brief."), "");
  await c.cellFs.fs.writeFile(`${CELL_CWD}/CLAUDE.md`, "x".repeat(20000));
  const big = await c.projectInstructions();
  check("and a very long file is cut rather than spending the whole context", big.length < 17_000 && big.endsWith("…"), String(big.length));
}

console.log(bad ? `\n${bad} FAILED` : "\nall claims hold");
process.exit(bad ? 1 : 0);
