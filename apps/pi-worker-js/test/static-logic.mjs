// THE PREVIEW SERVER'S CONTRACT, SERVED BY THE CELL. The daemon's static file
// server (port 3211: /health, /open?path=, /abs/<path>) over the cell's tree,
// under /static — what the file viewer frames for an HTML file.
// EXPECTED_PASSES=19
import { DatabaseSync } from "node:sqlite";
import { watchClaims } from "../../tools/crash-reporter.mjs";
import { installWorkerGlobals } from "./cell-harness.mjs";
installWorkerGlobals();
let bad = 0;
const check = watchClaims((n, c, d = "") => { if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });
const { cellFs, CELL_CWD } = await import("../src/execenv.cell.js");
const { staticAnswer, toAbsPath, injectBase, publicBaseUrl, STATIC_PREFIX } = await import("../src/cell-static.js");
const db = new DatabaseSync(":memory:");
const sql = { exec(q, ...a) { const t = q.trim(); if (/^(CREATE|INSERT|UPDATE|DELETE)/i.test(t)) { const st = db.prepare(t); a.length ? st.run(...a) : st.run(); return { toArray: () => [], [Symbol.iterator]: function* () {} }; } const rows = db.prepare(t).all(...a); return { toArray: () => rows, [Symbol.iterator]: function* () { yield* rows; } }; } };
const cell = cellFs(sql); await cell.ready;
await cell.fs.mkdir(`${CELL_CWD}/site/img`, { recursive: true });
await cell.fs.writeFile(`${CELL_CWD}/site/index.html`, "<html><head><title>t</title></head><body><h1>Blanc</h1><img src=\"img/logo.png\"><a href=\"#work\">w</a></body></html>");
await cell.fs.writeFile(`${CELL_CWD}/site/style.css`, "h1{color:red}");
await cell.fs.writeFile(`${CELL_CWD}/site/img/logo.png`, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1]));
await cell.fs.writeFile(`${CELL_CWD}/frag.html`, "<h1>fragment</h1>");
const PREFIX = "https://pi-js.kortix.com/v1/p/sid/3211";
async function call(route, headers = { "x-forwarded-prefix": PREFIX }, method = "GET") {
  const url = new URL(`http://cell${STATIC_PREFIX}${route}`);
  const res = await staticAnswer(new Request(url, { method, headers }), url.pathname, url, cell);
  if (!res) return { status: null };
  const ct = res.headers.get("content-type") ?? "";
  return { status: res.status, ct, headers: res.headers, body: /json|text|html|css|javascript/.test(ct) ? await res.text() : new Uint8Array(await res.arrayBuffer()) };
}

check("toAbsPath keeps a path under /workspace or /tmp, refuses others and climbs", toAbsPath("/workspace/a.html") === "/workspace/a.html" && toAbsPath("/tmp/x") === "/tmp/x" && toAbsPath("/etc/passwd") === null && toAbsPath("/workspace/../etc/passwd") === null && toAbsPath("relative") === null, "");
check("publicBaseUrl honours an absolute X-Forwarded-Prefix", publicBaseUrl(new Request("http://cell/static/open", { headers: { "x-forwarded-prefix": PREFIX + "/" } }), new URL("http://cell/static/open")) === PREFIX, "");
check("and a path-only prefix under the forwarded origin", publicBaseUrl(new Request("http://cell/x", { headers: { "x-forwarded-prefix": "/v1/p/sid/3211", "x-forwarded-proto": "https", "x-forwarded-host": "pi-js.kortix.com" } }), new URL("http://cell/x")) === PREFIX, "");
check("and falls back to the request's own origin", publicBaseUrl(new Request("http://cell:8080/x"), new URL("http://cell:8080/x")) === "http://cell:8080", "");
const injected = injectBase("<html><head></head><body></body></html>", "/workspace/site/index.html", PREFIX);
check("injectBase puts <base href=<prefix>/abs/<dir>/> into <head>, with the hash-link fix", injected.includes(`<head>\n  <base href="${PREFIX}/abs/workspace/site/">`) && injected.includes("history.replaceState"), injected.slice(0, 160));
check("a fragment with no head or html gets the base prepended", injectBase("<h1>x</h1>", "/workspace/f.html", PREFIX).startsWith(`<base href="${PREFIX}/abs/workspace/">`), "");

let r = await call("/health");
check("GET /static/health answers the daemon's health shape", r.status === 200 && JSON.parse(r.body).status === "ok" && JSON.parse(r.body).port === 3211, JSON.stringify(r.body));
r = await call("/open?path=/workspace/site/index.html");
check("GET /static/open serves the page as text/html with the <base> injected", r.status === 200 && /^text\/html/.test(r.ct) && r.body.includes(`<base href="${PREFIX}/abs/workspace/site/">`) && r.body.includes("<h1>Blanc</h1>"), `${r.status} ${r.ct} ${String(r.body).slice(0, 120)}`);
check("and CORS is open, like the daemon's", r.headers.get("access-control-allow-origin") === "*", "");
r = await call("/abs/workspace/site/style.css");
check("GET /static/abs/<path> serves an asset by mime, no injection", r.status === 200 && /^text\/css/.test(r.ct) && r.body === "h1{color:red}", `${r.status} ${r.ct}`);
r = await call("/abs/workspace/site/img/logo.png");
check("a binary asset streams its bytes as image/png", r.status === 200 && r.ct === "image/png" && r.body[0] === 0x89, `${r.status} ${r.ct}`);
r = await call("/open?path=/workspace/site");
check("a directory answers its index.html, injected", r.status === 200 && r.body.includes("<base href=") && r.body.includes("Blanc"), `${r.status}`);
r = await call("/open?path=/workspace/frag.html");
check("a fragment page still gets a base", r.status === 200 && r.body.startsWith("<base href="), String(r.body).slice(0, 80));
r = await call("/open?path=/workspace/missing.html");
check("a missing file is 404 'Not found: …'", r.status === 404 && /Not found: \/workspace\/missing\.html/.test(r.body), `${r.status} ${r.body}`);
r = await call("/open?path=/etc/passwd");
check("a path outside the roots is 400 (invalid path), never served", r.status === 400, `${r.status}`);
r = await call("/abs/etc/passwd");
check("and so is /abs/ outside the roots", r.status === 400, `${r.status}`);
r = await call("/open");
check("no path is 400", r.status === 400, `${r.status}`);
r = await call("/health", {}, "OPTIONS");
check("OPTIONS preflight is 204", r.status === 204, `${r.status}`);
const none = await staticAnswer(new Request("http://cell/file?path="), "/file", new URL("http://cell/file?path="), cell);
check("a route outside /static is left to the worker (null)", none === null, "");
console.log(bad ? `\n${bad} FAILED` : "\nall claims hold");
process.exit(bad ? 1 : 0);
