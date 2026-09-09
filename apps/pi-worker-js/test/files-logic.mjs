// THE FILES PANEL'S CONTRACT, SERVED BY THE CELL. The daemon's /file and
// /find routes (apps/kortix-sandbox-agent-server/src/routes) over the cell's
// own tree — shape for shape, so the Kortix client needs no change.
// EXPECTED_PASSES=36
import { DatabaseSync } from "node:sqlite";
import { watchClaims } from "../../tools/crash-reporter.mjs";
import { installWorkerGlobals } from "./cell-harness.mjs";
installWorkerGlobals();
let bad = 0;
const check = watchClaims((n, c, d = "") => { if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });
const { cellFs, CELL_CWD } = await import("../src/execenv.cell.js");
const { filesAnswer, resolvePath, fuzzyScore, mimeTypeFor, isLikelyBinary, normalizePath } = await import("../src/cell-files.js");

const db = new DatabaseSync(":memory:");
const sql = { exec(q, ...a) { const t = q.trim(); if (/^(CREATE|INSERT|UPDATE|DELETE)/i.test(t)) { const st = db.prepare(t); a.length ? st.run(...a) : st.run(); return { toArray: () => [], [Symbol.iterator]: function* () {} }; } const rows = db.prepare(t).all(...a); return { toArray: () => rows, [Symbol.iterator]: function* () { yield* rows; } }; } };

/** One request against the cell's file routes, the way the worker dispatches it. */
async function call(cell, method, route, { body, form } = {}) {
  const url = new URL(`http://cell${route}`);
  const path = url.pathname;
  const init = { method };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { "content-type": "application/json" }; }
  if (form) init.body = form;
  const res = await filesAnswer(new Request(url, init), path, url, cell);
  if (!res) return { status: null, body: null };
  const ct = res.headers.get("content-type") ?? "";
  return { status: res.status, headers: res.headers, body: ct.includes("application/json") ? await res.json() : new Uint8Array(await res.arrayBuffer()) };
}

// ---- pure helpers
check("resolvePath anchors a relative path under the workspace", resolvePath("a/b.txt") === `${CELL_CWD}/a/b.txt`, resolvePath("a/b.txt"));
check("resolvePath keeps an absolute path under an allowed root", resolvePath("/tmp/x") === "/tmp/x" && resolvePath(`${CELL_CWD}/y`) === `${CELL_CWD}/y`, "");
check("resolvePath refuses a path outside the roots, the daemon's words", (() => { try { resolvePath("/etc/passwd"); return false; } catch (e) { return /Access denied/.test(e.message); } })(), "");
check("and a `..` climb out of the workspace is refused too", (() => { try { resolvePath("../../etc/passwd"); return false; } catch (e) { return /Access denied/.test(e.message); } })(), "");
check("normalizePath collapses . and .. and //", normalizePath("/workspace//a/./b/../c") === "/workspace/a/c", normalizePath("/workspace//a/./b/../c"));
check("fuzzyScore ranks a substring hit above a subsequence, and nothing for a miss", fuzzyScore("src/app.ts", "app") > fuzzyScore("src/a_p_p.ts", "app") && fuzzyScore("readme", "zzz") === 0, "");
check("mime: html is text/html, png is image/png, unknown text is text/plain", mimeTypeFor("/x/a.html", false) === "text/html" && mimeTypeFor("a.png", true) === "image/png" && /text\/plain/.test(mimeTypeFor("a.unknownext", false)), "");
check("binary: by extension or by a NUL byte", isLikelyBinary(new Uint8Array([1, 2, 3]), "a.png") && isLikelyBinary(new Uint8Array([65, 0, 66]), "a.txt") && !isLikelyBinary(new TextEncoder().encode("plain"), "a.txt"), "");

// ---- the routes, over a real cell tree
const cell = cellFs(sql); await cell.ready;
let r = await call(cell, "GET", "/file?path=");
check("GET /file on the empty workspace lists nothing — not 'unknown route'", r.status === 200 && Array.isArray(r.body) && r.body.length === 0, JSON.stringify(r));
r = await call(cell, "GET", "/session/x/message");
check("a route that is not a file route is left to the worker (null)", r.status === null, "");

await cell.fs.mkdir(`${CELL_CWD}/src/lib`, { recursive: true });
await cell.fs.writeFile(`${CELL_CWD}/1664-blanc.html`, "<html><body><h1>Blanc</h1></body></html>");
await cell.fs.writeFile(`${CELL_CWD}/src/app.ts`, "export const beer = 'blanc';\nconst abv = 5;\n");
await cell.fs.writeFile(`${CELL_CWD}/src/lib/util.ts`, "export const x = 1;\n");
await cell.fs.writeFile(`${CELL_CWD}/logo.png`, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));

r = await call(cell, "GET", "/file?path=");
check("GET /file lists the root: directories first, then files by name, each with name/path/absolute/type/ignored",
  r.status === 200 && r.body.map((n) => n.name).join(",") === "src,1664-blanc.html,logo.png"
    && r.body[0].type === "directory" && r.body[0].path === "src" && r.body[0].absolute === `${CELL_CWD}/src` && r.body[0].ignored === false
    && r.body[1].type === "file" && r.body[1].absolute === `${CELL_CWD}/1664-blanc.html`, JSON.stringify(r.body));
r = await call(cell, "GET", "/file?path=src");
check("a relative path lists that directory with workspace-relative paths", r.status === 200 && r.body.map((n) => n.path).join(",") === "src/lib,src/app.ts", JSON.stringify(r.body));
r = await call(cell, "GET", `/file?path=${encodeURIComponent(CELL_CWD + "/src/lib")}`);
check("an absolute workspace path lists too", r.status === 200 && r.body.length === 1 && r.body[0].name === "util.ts", JSON.stringify(r.body));
r = await call(cell, "GET", "/file?path=nope");
check("a missing directory is 404 'Directory not found'", r.status === 404 && r.body.error === "Directory not found", JSON.stringify(r.body));
r = await call(cell, "GET", "/file?path=src/app.ts");
check("listing a file is 400", r.status === 400, JSON.stringify(r.body));
r = await call(cell, "GET", "/file?path=/etc");
check("a path outside the roots is 403 Access denied", r.status === 403 && /Access denied/.test(r.body.error), JSON.stringify(r.body));

r = await call(cell, "GET", "/file/content?path=1664-blanc.html");
check("GET /file/content on a text file: type text, the text, its mime, its size", r.status === 200 && r.body.type === "text" && r.body.content.includes("<h1>Blanc</h1>") && r.body.mimeType === "text/html" && r.body.size === 40, JSON.stringify(r.body));
r = await call(cell, "GET", "/file/content?path=logo.png");
check("on a binary file: type binary, base64, encoding base64, image/png", r.status === 200 && r.body.type === "binary" && r.body.encoding === "base64" && r.body.mimeType === "image/png" && atob(r.body.content).charCodeAt(0) === 0x89, JSON.stringify(r.body));
r = await call(cell, "GET", "/file/content?path=missing.txt");
check("a missing file is 404 'File not found'", r.status === 404 && r.body.error === "File not found", JSON.stringify(r.body));
r = await call(cell, "GET", "/file/content?path=src");
check("content of a directory is 400", r.status === 400, JSON.stringify(r.body));
r = await call(cell, "GET", "/file/content");
check("no path is 400", r.status === 400, JSON.stringify(r.body));
r = await call(cell, "GET", "/file/raw?path=1664-blanc.html");
check("GET /file/raw streams the bytes with the file's content-type and no-store", r.status === 200 && r.headers.get("content-type") === "text/html" && r.headers.get("cache-control") === "no-store" && new TextDecoder().decode(r.body).startsWith("<html>"), String(r.headers.get("content-type")));
r = await call(cell, "GET", "/file/status");
check("GET /file/status is an empty status list (no git in the tree)", r.status === 200 && Array.isArray(r.body) && r.body.length === 0, JSON.stringify(r.body));

// ---- search
r = await call(cell, "GET", "/find/file?query=app");
check("GET /find/file ranks by fuzzy match over files and directories", r.status === 200 && r.body[0] === "src/app.ts", JSON.stringify(r.body));
r = await call(cell, "GET", "/find/file?query=&type=directory");
check("type=directory lists only directories", r.status === 200 && r.body.sort().join(",") === "src,src/lib", JSON.stringify(r.body));
r = await call(cell, "GET", "/find?pattern=lanc");
check("GET /find answers ripgrep's match shape — path, the line, line_number, submatches", r.status === 200 && r.body.length === 2
  && r.body.some((m) => m.path === "./src/app.ts" && m.line_number === 1 && m.lines === "export const beer = 'blanc';\n" && m.submatches[0].start === 22 && m.submatches[0].end === 26)
  && r.body.some((m) => m.path === "./1664-blanc.html"), JSON.stringify(r.body));
r = await call(cell, "GET", "/find?pattern=");
check("no pattern is 400", r.status === 400, "");
r = await call(cell, "GET", "/find?pattern=[");
check("an invalid regex searches literally instead of throwing", r.status === 200 && Array.isArray(r.body), JSON.stringify(r.body));

// ---- writes go to storage
const form = new FormData();
form.append("path", "uploads");
form.append("file", new File([new TextEncoder().encode("hello upload")], "note.txt", { type: "text/plain" }));
r = await call(cell, "POST", "/file/upload", { form });
check("POST /file/upload writes under the target directory and answers path+size", r.status === 200 && r.body[0]?.path === `${CELL_CWD}/uploads/note.txt` && r.body[0].size === 12, JSON.stringify(r.body));
r = await call(cell, "POST", "/file/upload", { form });
check("uploading the same name again never overwrites — a suffixed name", r.status === 200 && r.body[0].path !== `${CELL_CWD}/uploads/note.txt` && /note-.*\.txt$/.test(r.body[0].path), JSON.stringify(r.body));
r = await call(cell, "POST", "/file/mkdir", { body: { path: "docs/new" } });
check("POST /file/mkdir creates parents and answers true", r.status === 200 && r.body === true && (await cell.fs.exists(`${CELL_CWD}/docs/new`)), JSON.stringify(r.body));
r = await call(cell, "POST", "/file/rename", { body: { from: "src/lib/util.ts", to: "src/lib/helpers.ts" } });
check("POST /file/rename moves and answers from/to", r.status === 200 && r.body.to === `${CELL_CWD}/src/lib/helpers.ts` && !(await cell.fs.exists(`${CELL_CWD}/src/lib/util.ts`)), JSON.stringify(r.body));
r = await call(cell, "DELETE", "/file", { body: { path: "logo.png" } });
check("DELETE /file removes and answers true; a second delete is 404", r.status === 200 && r.body === true && (await call(cell, "DELETE", "/file", { body: { path: "logo.png" } })).status === 404, JSON.stringify(r.body));
const stored = sql.exec("SELECT path FROM files ORDER BY path").toArray().map((x) => x.path);
check("every write above went to storage — the uploaded, made and renamed paths are rows", stored.includes(`${CELL_CWD}/uploads/note.txt`) && stored.includes(`${CELL_CWD}/docs/new`) && stored.includes(`${CELL_CWD}/src/lib/helpers.ts`) && !stored.includes(`${CELL_CWD}/logo.png`), JSON.stringify(stored));

// ---- a tree from before the move (rows under /work) is served under /workspace
const db2 = new DatabaseSync(":memory:");
const sql2 = { exec(q, ...a) { const t = q.trim(); if (/^(CREATE|INSERT|UPDATE|DELETE)/i.test(t)) { const st = db2.prepare(t); a.length ? st.run(...a) : st.run(); return { toArray: () => [], [Symbol.iterator]: function* () {} }; } const rows = db2.prepare(t).all(...a); return { toArray: () => rows, [Symbol.iterator]: function* () { yield* rows; } }; } };
sql2.exec("CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, dir INTEGER NOT NULL, mode INTEGER, mtime INTEGER, body TEXT)");
sql2.exec("INSERT INTO files(path, dir, mode, mtime, body) VALUES (?, ?, ?, ?, ?)", "/work", 1, 0o755, 1, null);
sql2.exec("INSERT INTO files(path, dir, mode, mtime, body) VALUES (?, ?, ?, ?, ?)", "/work/old.html", 0, 0o644, 1, btoa("<p>old</p>"));
const legacy = cellFs(sql2); await legacy.ready;
r = await call(legacy, "GET", "/file?path=");
check("a legacy /work tree restores under /workspace and lists there", r.status === 200 && r.body.length === 1 && r.body[0].absolute === `${CELL_CWD}/old.html`, JSON.stringify(r.body));
await legacy.persist();
const after = sql2.exec("SELECT path FROM files ORDER BY path").toArray().map((x) => x.path);
check("and the next persist rewrites the rows — no /work row survives", after.every((p) => !p.startsWith("/work/") && p !== "/work") && after.includes(`${CELL_CWD}/old.html`), JSON.stringify(after));

console.log(bad ? `\n${bad} FAILED` : "\nall claims hold");
process.exit(bad ? 1 : 0);
