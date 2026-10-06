// THE KORTIX TOOLS A PI SESSION HAS: web_search, image_search, scrape_webpage,
// memory and show — ported from kortixd's pi harness (harness/pi/kortix-*.ts).
//
// The claims are about parity with kortixd: the endpoint and headers each web
// tool sends to the API's router proxy, the output JSON a client renders, the
// error texts, and the memory tool's return strings and path sandbox. The web
// tools run against a local HTTP mock of the API; nothing leaves the machine.
// memory and show run over the cell's own tree (src/execenv.cell.js), the
// same ExecutionEnv pi hands them in a cell.
// EXPECTED_PASSES=69
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { watchClaims } from "../../tools/crash-reporter.mjs";
import { installWorkerGlobals } from "./cell-harness.mjs";
installWorkerGlobals();

let bad = 0, claims = 0;
const check = watchClaims((n, c, d = "") => { claims++; if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });

const { kortixTools, KORTIX_TOOL_NAMES, toolCapability } = await import("../src/kortix-tools/index.js");
const { createWebSearchTool, createImageSearchTool, createScrapeWebpageTool } = await import("../src/kortix-tools/web.js");
const { cellFs, cellExecutionEnv } = await import("../src/execenv.cell.js");

// ── the API mock ────────────────────────────────────────────────────────────
// One handler per route, swapped per claim; every request is recorded.
const seen = [];
let handlers = {};
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
    const h = handlers[req.url];
    const [status, payload] = h ? h(JSON.parse(body || "null")) : [404, { error: "no route" }];
    res.writeHead(status, { "content-type": "application/json" });
    res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const API = `http://127.0.0.1:${server.address().port}`;
const ENV = { KORTIX_API_URL: API, KORTIX_TOKEN: "tok-sandbox" };

const out = (r) => r.content.map((c) => c.text).join("");
const outJson = (r) => JSON.parse(out(r));
const thrown = async (p) => { try { await p; return null; } catch (e) { return e.message; } };
const last = () => seen.at(-1);

// ── the set ─────────────────────────────────────────────────────────────────
{
  const tools = kortixTools({ env: ENV, fsEnv: () => null });
  check("kortixTools returns the five tools in kortixd's order, ungated",
    JSON.stringify(tools.map((t) => t.name)) === JSON.stringify(["web_search", "image_search", "scrape_webpage", "memory", "show"])
      && JSON.stringify(KORTIX_TOOL_NAMES) === JSON.stringify(tools.map((t) => t.name)),
    JSON.stringify(tools.map((t) => t.name)));
  check("every tool carries a label, a description, a typebox schema and execute",
    tools.every((t) => t.label === t.name && t.description.length > 50 && t.parameters?.type === "object" && typeof t.execute === "function"));
  const schema = tools.find((t) => t.name === "memory").parameters;
  check("memory's command is a plain string enum of the six commands (pi-ai StringEnum's schema)",
    schema.properties.command.type === "string" && JSON.stringify(schema.properties.command.enum) === JSON.stringify(["view", "create", "str_replace", "insert", "delete", "rename"])
      && JSON.stringify(schema.required) === JSON.stringify(["command"]), JSON.stringify(schema.properties.command));
  check("permission capabilities: web_search/image_search -> websearch, scrape_webpage -> webfetch, write -> edit",
    toolCapability("web_search") === "websearch" && toolCapability("image_search") === "websearch" && toolCapability("scrape_webpage") === "webfetch"
      && toolCapability("write") === "edit" && toolCapability("show") === "show");
  check("memory view is a read, every other memory command an edit",
    toolCapability("memory", { command: "view" }) === "read" && toolCapability("memory", { command: "create" }) === "edit" && toolCapability("memory") === "edit");
  // The adapter the worker installs them through (engine.js), unchanged.
  const { fromAgentTool } = await import("../src/engine.js");
  const lifted = tools.map((t) => fromAgentTool(t, { replay: "unsafe" }));
  check("each lifts into a pi-durable registration through engine.js fromAgentTool",
    lifted.every((r, i) => r.name === tools[i].name && r.parameters === tools[i].parameters && typeof r.execute === "function" && r.replay === "unsafe"),
    JSON.stringify(lifted.map((r) => [r.name, r.replay])));
}

// ── web_search ──────────────────────────────────────────────────────────────
{
  const tool = createWebSearchTool({ env: () => ENV });
  handlers = { "/v1/router/tavily/search": () => [200, {
    answer: "A synthesized answer.",
    results: [{ title: "T", url: "https://e.com", content: "snip", score: 0.9, published_date: "2026-10-01" }, { url: "https://f.com" }],
    images: ["https://i/1.png", { url: "https://i/2.png", description: "two" }],
    response_time: 1.25,
  }] };
  const r = outJson(await tool.execute("c1", { query: "kortix" }));
  const req = last();
  check("web_search POSTs to <api>/v1/router/tavily/search — /v1 appended to a bare KORTIX_API_URL",
    req.method === "POST" && req.url === "/v1/router/tavily/search", `${req.method} ${req.url}`);
  check("with the sandbox token as a Bearer, the router holds the upstream key",
    req.headers.authorization === "Bearer tok-sandbox" && req.headers["content-type"] === "application/json", JSON.stringify(req.headers));
  check("the body is kortixd's: basic depth, general topic, 5 results, answer and described images",
    JSON.stringify(req.body) === JSON.stringify({ query: "kortix", search_depth: "basic", topic: "general", max_results: 5, include_answer: true, include_images: true, include_image_descriptions: true }),
    JSON.stringify(req.body));
  check("the output maps Tavily's content to snippet and fills every missing field",
    r.query === "kortix" && r.success === true && r.answer === "A synthesized answer." && r.results.length === 2
      && r.results[0].snippet === "snip" && r.results[1].title === "" && r.results[1].score === 0 && r.results[1].published_date === ""
      && r.response_time_ms === 1.25, JSON.stringify(r).slice(0, 200));
  check("string and object images both become {url, description}",
    JSON.stringify(r.images) === JSON.stringify([{ url: "https://i/1.png", description: "" }, { url: "https://i/2.png", description: "two" }]), JSON.stringify(r.images));

  await tool.execute("c2", { query: "a ||| b", num_results: 50, topic: "news", search_depth: "advanced" });
  const two = seen.slice(-2).map((s) => s.body);
  check("a ||| batch sends one request per query, num_results clamped to 20, topic and depth passed through",
    two.length === 2 && two.map((b) => b.query).sort().join(",") === "a,b" && two.every((b) => b.max_results === 20 && b.topic === "news" && b.search_depth === "advanced"),
    JSON.stringify(two));
  const batch = outJson(await tool.execute("c3", { query: "a ||| b" }));
  check("and answers {batch_mode, total_queries, results} in query order",
    batch.batch_mode === true && batch.total_queries === 2 && batch.results.map((x) => x.query).join(",") === "a,b", JSON.stringify(batch).slice(0, 120));
  await tool.execute("c4", { query: "x", num_results: 0 });
  check("num_results 0 is clamped up to 1", last().body.max_results === 1, JSON.stringify(last().body));

  handlers = { "/v1/router/tavily/search": () => [502, "upstream down"] };
  const failed = outJson(await tool.execute("c5", { query: "q" }));
  check("an upstream failure is a result with success:false and kortixd's error text, not a throw",
    failed.success === false && failed.query === "q" && failed.error === "Error: 502 Error: upstream down", JSON.stringify(failed));

  const v1 = createWebSearchTool({ env: { ...ENV, KORTIX_API_URL: `${API}/v1/` } });
  handlers = { "/v1/router/tavily/search": () => [200, { results: [] }] };
  const empty = outJson(await v1.execute("c6", { query: "nothing" }));
  check("a KORTIX_API_URL that already ends in /v1 is not doubled; no results and no answer is success:false",
    last().url === "/v1/router/tavily/search" && empty.success === false && empty.results.length === 0, `${last().url} ${JSON.stringify(empty)}`);

  check("an empty query throws kortixd's text", (await thrown(tool.execute("c7", { query: " ||| " }))) === "The query is empty.");
  check("a control plane with no token throws 'KORTIX_TOKEN is not set.'",
    (await thrown(createWebSearchTool({ env: { KORTIX_API_URL: API } }).execute("c8", { query: "q" }))) === "KORTIX_TOKEN is not set.");
  check("no control plane and no project key throws 'TAVILY_API_KEY is not set.'",
    (await thrown(createWebSearchTool({ env: {} }).execute("c9", { query: "q" }))) === "TAVILY_API_KEY is not set.");
  const direct = [];
  const directTool = createWebSearchTool({ env: { TAVILY_API_KEY: "tv-key" }, fetch: async (url, init) => { direct.push({ url, init }); return new Response(JSON.stringify({ answer: "x" }), { status: 200 }); } });
  await directTool.execute("c10", { query: "q" });
  check("with no control plane it calls Tavily itself with the project's key",
    direct[0]?.url === "https://api.tavily.com/search" && direct[0].init.headers.Authorization === "Bearer tv-key", JSON.stringify(direct[0]?.url));
}

// ── image_search ────────────────────────────────────────────────────────────
{
  const tool = createImageSearchTool({ env: ENV });
  handlers = { "/v1/router/serper/images": (body) => [200, Array.isArray(body)
    ? body.map((b) => ({ images: [{ imageUrl: `https://img/${b.q}.png` }] }))
    : { images: [{ imageUrl: "https://img/1.png", title: "One", link: "https://src/1", imageWidth: 640, imageHeight: 480 }] }] };
  const r = outJson(await tool.execute("i1", { query: "cats" }));
  const req = last();
  check("image_search POSTs to <api>/v1/router/serper/images with the token as X-API-KEY",
    req.url === "/v1/router/serper/images" && req.headers["x-api-key"] === "tok-sandbox" && !req.headers.authorization, JSON.stringify(req.headers));
  check("one query sends one object with num 12",
    JSON.stringify(req.body) === JSON.stringify({ q: "cats", num: 12 }), JSON.stringify(req.body));
  check("and answers {query, total, images[url,title,source,width,height]}",
    r.query === "cats" && r.total === 1 && JSON.stringify(r.images[0]) === JSON.stringify({ url: "https://img/1.png", title: "One", source: "https://src/1", width: 640, height: 480 }),
    JSON.stringify(r));
  const b = outJson(await tool.execute("i2", { query: "cats ||| dogs", num_results: 500 }));
  check("a batch sends ONE request with an array body, num clamped to 100",
    Array.isArray(last().body) && last().body.length === 2 && last().body.every((x) => x.num === 100), JSON.stringify(last().body));
  check("and answers {batch_mode, results} per query, missing fields defaulted",
    b.batch_mode === true && b.results.map((x) => x.query).join(",") === "cats,dogs" && b.results[1].images[0].url === "https://img/dogs.png" && b.results[1].images[0].width === 0,
    JSON.stringify(b).slice(0, 200));
  handlers = { "/v1/router/serper/images": () => [200, { images: [] }] };
  const none = await tool.execute("i3", { query: "zzz" });
  check("no images is plain text, not JSON", out(none) === "No images found for: 'zzz'", out(none));
  handlers = { "/v1/router/serper/images": () => [500, "boom"] };
  check("a failed request throws kortixd's text", (await thrown(tool.execute("i4", { query: "q" }))) === "Serper API returned 500: boom");
}

// ── scrape_webpage ──────────────────────────────────────────────────────────
{
  const tool = createScrapeWebpageTool({ env: ENV });
  handlers = { "/v1/router/firecrawl/v2/scrape": (body) => body.url.includes("bad")
    ? [200, { success: false, error: "blocked by robots" }]
    : [200, { success: true, data: { markdown: `# ${body.url}`, html: "<h1>x</h1>", metadata: { title: "Page" } } }] };
  const r = outJson(await tool.execute("s1", { urls: "https://e.com/a" }));
  const req = last();
  check("scrape_webpage POSTs to <api>/v1/router/firecrawl/v2/scrape with a Bearer token",
    req.url === "/v1/router/firecrawl/v2/scrape" && req.headers.authorization === "Bearer tok-sandbox", `${req.url} ${req.headers.authorization}`);
  check("asking for markdown only, with Firecrawl's 30 s timeout",
    JSON.stringify(req.body) === JSON.stringify({ url: "https://e.com/a", formats: ["markdown"], timeout: 30000 }), JSON.stringify(req.body));
  check("one URL answers {url, success, title, content, content_length, metadata} and no html",
    r.url === "https://e.com/a" && r.success === true && r.title === "Page" && r.content === "# https://e.com/a" && r.content_length === r.content.length
      && r.metadata?.title === "Page" && !("html" in r), JSON.stringify(r));
  const h = outJson(await tool.execute("s2", { urls: "https://e.com/h", include_html: true }));
  check("include_html asks for both formats and returns the html",
    JSON.stringify(last().body.formats) === JSON.stringify(["markdown", "html"]) && h.html === "<h1>x</h1>", JSON.stringify(h).slice(0, 120));
  const mixed = outJson(await tool.execute("s3", { urls: "https://e.com/a, https://bad.com/x ," }));
  check("several URLs answer {total, successful, failed, results}; a failed one carries its error",
    mixed.total === 2 && mixed.successful === 1 && mixed.failed === 1 && mixed.results[1].success === false && mixed.results[1].error === "blocked by robots",
    JSON.stringify(mixed).slice(0, 200));
  const allBad = await thrown(tool.execute("s4", { urls: "https://bad.com/1,https://bad.com/2" }));
  check("every URL failing throws kortixd's summary",
    allBad === "Failed to scrape all 2 URLs. https://bad.com/1: blocked by robots; https://bad.com/2: blocked by robots", allBad);
  check("no URLs throws 'No valid URLs provided.'", (await thrown(tool.execute("s5", { urls: " , " }))) === "No valid URLs provided.");

  // A timeout is retried with 2 s, then 4 s backoff (sleep injected); anything else is not.
  let calls = 0;
  const slept = [];
  const flaky = createScrapeWebpageTool({
    env: ENV,
    sleep: async (ms) => { slept.push(ms); },
    fetch: async () => {
      calls++;
      if (calls < 3) throw new Error("The operation was aborted due to timeout");
      return new Response(JSON.stringify({ success: true, data: { markdown: "ok", metadata: {} } }), { status: 200 });
    },
  });
  const retried = outJson(await flaky.execute("s6", { urls: "https://slow.com" }));
  check("a timeout is retried up to three attempts, backing off 2 s then 4 s",
    retried.success === true && calls === 3 && JSON.stringify(slept) === "[2000,4000]" && !("metadata" in retried), `${calls} calls, slept ${JSON.stringify(slept)}`);
  calls = 0;
  const refused = createScrapeWebpageTool({ env: ENV, sleep: async () => {}, fetch: async () => { calls++; throw new Error("connection refused"); } });
  const once = await thrown(refused.execute("s7", { urls: "https://down.com" }));
  check("a non-timeout failure is not retried", calls === 1 && once === "Failed to scrape all 1 URLs. https://down.com: connection refused", `${calls} ${once}`);
}

// ── memory and show, over the cell's own tree ──────────────────────────────
const db = new DatabaseSync(":memory:");
const sql = { exec(q, ...a) { const t = q.trim(); if (/^(CREATE|INSERT|UPDATE|DELETE)/i.test(t)) { const st = db.prepare(t); a.length ? st.run(...a) : st.run(); return { toArray: () => [], [Symbol.iterator]: function* () {} }; } const rows = db.prepare(t).all(...a); return { toArray: () => rows, [Symbol.iterator]: function* () { yield* rows; } }; } };
const cell = cellFs(sql); await cell.ready;
const tree = cellExecutionEnv(cell);
const [, , , memoryTool, showTool] = kortixTools({ env: ENV, fsEnv: () => tree });
const mem = async (args, viaCtx = true) => out(await memoryTool.execute("m", args, undefined, undefined, viaCtx ? { env: tree } : undefined));
const read = async (p) => { const r = await tree.readTextFile(p); return r.ok ? r.value : null; };

{
  let r = await mem({ command: "view", path: "memory" });
  check("view of an empty project creates memory/ and lists it with kortixd's header",
    r.startsWith("Here're the files and directories up to 2 levels deep in memory, excluding hidden items and node_modules:\n") && (await tree.exists("memory")).value === true, r);
  r = await mem({ command: "create", path: "memory/notes.md", file_text: "alpha\nbeta\ngamma\n" });
  check("create writes the file and answers kortixd's text",
    r === "File created successfully at: memory/notes.md" && (await read("memory/notes.md")) === "alpha\nbeta\ngamma\n", r);
  r = await mem({ command: "create", path: "memory/notes.md", file_text: "clobber" });
  check("create never truncates an existing file", r === "Error: File memory/notes.md already exists" && (await read("memory/notes.md")) === "alpha\nbeta\ngamma\n", r);
  r = await mem({ command: "view", path: "./memory/notes.md", view_range: [2, 3] });
  check("view of a file numbers lines in a 6-wide column; view_range slices; ./ is accepted",
    r === "Here's the content of ./memory/notes.md with line numbers:\n     2\tbeta\n     3\tgamma", JSON.stringify(r));
  r = await mem({ command: "str_replace", path: "memory/notes.md", old_str: "beta", new_str: "BETA" });
  check("str_replace edits a unique match and shows the snippet around it",
    r.startsWith("The memory file has been edited. Here is the snippet showing the change (with line numbers):\n     1\talpha\n     2\tBETA") && (await read("memory/notes.md")) === "alpha\nBETA\ngamma\n", JSON.stringify(r));
  r = await mem({ command: "str_replace", path: "memory/notes.md", old_str: "nope", new_str: "x" });
  check("a missing old_str is refused with kortixd's text",
    r === "No replacement was performed, old_str `nope` did not appear verbatim in memory/notes.md.", r);
  r = await mem({ command: "str_replace", path: "memory/notes.md", old_str: "a", new_str: "x" });
  check("an ambiguous old_str names the lines it matched",
    r === "No replacement was performed. Multiple occurrences of old_str `a` in lines: 1, 3. Please ensure it is unique", r);
  r = await mem({ command: "insert", path: "memory/notes.md", insert_line: 0, insert_text: "top\n" });
  check("insert at 0 puts the line first, its trailing newline dropped",
    r === "The file memory/notes.md has been edited." && (await read("memory/notes.md")) === "top\nalpha\nBETA\ngamma\n", JSON.stringify(await read("memory/notes.md")));
  r = await mem({ command: "insert", path: "memory/notes.md", insert_line: 99, insert_text: "x" });
  check("an out-of-range insert_line names the valid range",
    r === "Error: Invalid `insert_line` parameter: 99. It should be within the range of lines of the file: [0, 5]", r);
  const leftovers = (await tree.listDir("memory")).value.filter((e) => e.name.startsWith(".tmp-"));
  check("the atomic writes leave no temp file behind", leftovers.length === 0, JSON.stringify(leftovers.map((e) => e.name)));

  await mem({ command: "create", path: "memory/topics/deep/deeper/x.md", file_text: "x" });
  await tree.writeFile("memory/.hidden", "h");
  r = await mem({ command: "view", path: "memory" });
  check("a directory view lists two levels, directories with a slash, hidden files skipped",
    r.includes("\tmemory/notes.md") && r.includes("\tmemory/topics/") && r.includes("\tmemory/topics/deep/") && !r.includes("deeper") && !r.includes(".hidden"), r);

  r = await mem({ command: "rename", old_path: "memory/notes.md", new_path: "memory/archive/notes.md" });
  check("rename moves the file, creating the destination's parent",
    r === "Successfully renamed memory/notes.md to memory/archive/notes.md" && (await read("memory/archive/notes.md"))?.startsWith("top") && (await read("memory/notes.md")) === null, r);
  await mem({ command: "create", path: "memory/b.md", file_text: "b" });
  r = await mem({ command: "rename", old_path: "memory/b.md", new_path: "memory/archive/notes.md" });
  check("rename refuses to overwrite an existing destination", r === "Error: The destination memory/archive/notes.md already exists", r);
  r = await mem({ command: "rename", old_path: "memory/gone.md", new_path: "memory/c.md" });
  check("rename of a missing source answers kortixd's text", r === "Error: The path memory/gone.md does not exist", r);
  r = await mem({ command: "delete", path: "memory/topics" });
  check("delete removes a directory recursively", r === "Successfully deleted memory/topics" && (await tree.exists("memory/topics")).value === false, r);
  r = await mem({ command: "delete", path: "memory/topics" });
  check("delete of a missing path answers kortixd's text", r === "Error: The path memory/topics does not exist", r);
  r = await mem({ command: "delete", path: "memory" });
  check("the memory root itself cannot be deleted", r === "Cannot delete the memory directory itself" && (await tree.exists("memory")).value === true, r);
  r = await mem({ command: "view", path: "memory/missing.md" });
  check("view of a missing path is an answer, not an error", r === "The path memory/missing.md does not exist. Please provide a valid path.", r);

  // ── the path sandbox ──
  r = await mem({ command: "view", path: "notes/x.md" });
  check("a path outside memory/ is refused", r === "Error: Path must start with memory, got: notes/x.md", r);
  r = await mem({ command: "view", path: "memory-evil/x" });
  check("a sibling directory that only shares the prefix is refused", r === "Error: Path must start with memory, got: memory-evil/x", r);
  r = await mem({ command: "create", path: "memory/../secret.md", file_text: "s" });
  check("a .. escape is refused and writes nothing", r === "Error: Path memory/../secret.md would escape memory directory" && (await read("secret.md")) === null, r);
  await tree.writeFile("outside/secret.txt", "s3cret");
  await cell.fs.symlink("/workspace/outside", "/workspace/memory/link");
  r = await mem({ command: "view", path: "memory/link/secret.txt" });
  check("a symlink out of memory/ is refused before anything is read", r === "Error: Path would escape memory directory via symlink", r);
  r = await mem({ command: "create", path: "memory/link/new.md", file_text: "x" });
  check("and nothing is written through it", r === "Error: Path would escape memory directory via symlink" && (await read("outside/new.md")) === null, r);

  r = await mem({ command: "create", path: "memory/x.md" });
  check("a missing required argument is named", r === "Error: `file_text` is required for create.", r);
  r = await mem({ command: "rename", old_path: "memory/x.md", new_path: "" });
  check("an empty path counts as missing", r === "Error: `new_path` is required for rename.", r);
  r = await mem({ command: "explode" });
  check("an unknown command answers 'Error: unknown command'", r === "Error: unknown command", r);
  r = await mem({ command: "view", path: "memory/archive/notes.md" }, false);
  check("with no ctx.env the tool falls back to fsEnv()", r.startsWith("Here's the content of memory/archive/notes.md"), r.slice(0, 80));
}

{
  const show = async (args) => outJson(await showTool.execute("s", args, undefined, undefined, { env: tree }));
  let r = await show({ action: "show", type: "text", title: "Build", content: "Build succeeded in 3.2s" });
  check("show of inline text answers {success, action, entry, message}, detail by default",
    r.success === true && r.action === "show" && r.entry.type === "text" && r.entry.variant === "detail" && r.entry.content === "Build succeeded in 3.2s"
      && /^show_\d+_[a-z0-9]+$/.test(r.entry.id) && !Number.isNaN(Date.parse(r.entry.timestamp)) && r.message === "Item 'Build' presented to user.", JSON.stringify(r));
  await tree.writeFile("out/logo.png", "png");
  r = await show({ action: "show", type: "image", path: "out/logo.png", theme: "default", metadata: '{"width":1024}' });
  check("a relative path resolves against /workspace, gallery for an image, a default theme dropped, metadata parsed",
    r.entry.path === "/workspace/out/logo.png" && r.entry.variant === "gallery" && !("theme" in r.entry) && r.entry.metadata?.width === 1024 && r.message === "Item 'image' presented to user.",
    JSON.stringify(r.entry));
  const missing = await thrown(showTool.execute("s", { action: "show", type: "pdf", path: "nope.pdf" }, undefined, undefined, { env: tree }));
  check("a file that does not exist is refused with its absolute path", missing === "File not found: /workspace/nope.pdf", missing);
  const badVariant = await thrown(showTool.execute("s", { action: "show", type: "url", url: "https://e.com", variant: "huge" }, undefined, undefined, { env: tree }));
  check("an invalid variant is refused with the valid list", badVariant === "Invalid variant 'huge'. Use one of: compact, full, gallery, detail.", badVariant);
  r = await show({ action: "show", title: "Logos", items: JSON.stringify([{ type: "image", title: "v1", path: "/workspace/out/logo.png" }, { type: "image", path: "/workspace/out/v2.png" }, 7]) });
  check("items show as a carousel; failed items become warnings, not a failure",
    r.items.length === 1 && r.title === "Logos" && JSON.stringify(r.warnings) === JSON.stringify(["Item 1: File not found: /workspace/out/v2.png", "Item 2: must be an object."])
      && r.message === "1 item(s) presented to user as carousel.", JSON.stringify(r).slice(0, 240));
  const badItems = await thrown(showTool.execute("s", { action: "show", items: "[{" }, undefined, undefined, { env: tree }));
  check("items that are not JSON are refused", badItems === "Invalid JSON in 'items' parameter. Must be a JSON array of objects.", badItems);
}

server.close();
console.log(bad ? `\n  ${bad} failure(s) of ${claims}` : `\n  the Kortix tools match kortixd: ${claims} claims`);
process.exit(bad ? 1 : 0);
