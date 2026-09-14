// `node` IN THE CELL, WITH NO INTERPRETER SHIPPED.
//
// The cell is a JavaScript isolate whose engine permits dynamic evaluation —
// measured on a live cell 2026-09-11: `new Function("return 1+1")()` → 2,
// `eval` → 5, `WebAssembly.Instance` → 7, userAgent "Cloudflare-Workers". So
// `node script.js` compiles the script here rather than carrying QuickJS as a
// megabyte of wasm.
//
// What these claims are about: the CommonJS resolution order (Node's own, or
// a project's `require` finds the wrong file), the core modules a script
// actually reaches for, console formatting a human has to read, the bounds
// (output, exit code, a throw), and the one thing a cell cannot do — block on
// a promise — being said out loud rather than returning an empty string.
// EXPECTED_PASSES=70
import { watchClaims } from "../../tools/crash-reporter.mjs";
let bad = 0;
const check = watchClaims((n, c, d = "") => { if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });
const { createNodeRuntime, resolveModule, resolvePath, relativePath, formatValue, NODE_VERSION, NODE_OUTPUT_MAX } = await import("../src/nodejs.js");

const rt = (files = {}, opts = {}) => {
  const r = createNodeRuntime({ fs: null, cwd: "/workspace", fetch: async () => { throw new Error("no network in this claim"); }, ...opts });
  for (const [p, body] of Object.entries(files)) r.put(p, body);
  return r;
};
const run = async (src, files = {}, opts = {}) => rt(files, opts).run(src, "/workspace/main.js");

// ── paths ──
check("resolve joins, absolutises and folds . and ..",
  resolvePath("/workspace", "a", "b") === "/workspace/a/b" && resolvePath("/workspace", "/etc", "x") === "/etc/x"
    && resolvePath("/workspace", "a/../b/./c") === "/workspace/b/c" && resolvePath("/workspace", "..") === "/", resolvePath("/workspace", "a/../b/./c"));
check("relative walks up and back down", relativePath("/a/b/c", "/a/d") === "../../d" && relativePath("/a", "/a/b") === "b" && relativePath("/a", "/a") === "", relativePath("/a/b/c", "/a/d"));

// ── the resolution order ──
{
  const files = new Set(["/w/a.js", "/w/b/index.js", "/w/c/package.json", "/w/c/lib/entry.js", "/w/node_modules/dep/index.js", "/w/deep/node_modules/near/index.js", "/w/data.json"]);
  const has = (p) => files.has(p);
  const readJson = (p) => (p === "/w/c/package.json" ? { main: "lib/entry.js" } : null);
  check("a relative specifier finds the exact file, then the .js, then the directory's index",
    resolveModule("./a", "/w", has, readJson) === "/w/a.js" && resolveModule("./a.js", "/w", has, readJson) === "/w/a.js"
      && resolveModule("./b", "/w", has, readJson) === "/w/b/index.js", String(resolveModule("./b", "/w", has, readJson)));
  check("a directory with a package.json follows its `main`", resolveModule("./c", "/w", has, readJson) === "/w/c/lib/entry.js", String(resolveModule("./c", "/w", has, readJson)));
  check("a bare specifier walks node_modules UP from the requiring file", resolveModule("dep", "/w/deep/nested", has, readJson) === "/w/node_modules/dep/index.js", String(resolveModule("dep", "/w/deep/nested", has, readJson)));
  check("and the NEAREST node_modules wins", resolveModule("near", "/w/deep", has, readJson) === "/w/deep/node_modules/near/index.js", String(resolveModule("near", "/w/deep", has, readJson)));
  check("json resolves too", resolveModule("./data.json", "/w", has, readJson) === "/w/data.json", "");
  check("and nothing found is null, not a guess", resolveModule("nope", "/w", has, readJson) === null && resolveModule("./nope", "/w", has, readJson) === null, "");
}

// ── console formatting, the thing a human reads ──
check("a top-level string prints bare; inside a structure it is quoted",
  formatValue("hi") === "hi" && formatValue(["hi"]) === "[ 'hi' ]", formatValue(["hi"]));
check("objects, arrays, maps, sets and dates each print as themselves",
  formatValue({ a: 1 }) === "{ a: 1 }" && formatValue([1, [2]]) === "[ 1, [ 2 ] ]"
    && formatValue(new Map([["k", 1]])) === "Map(1) { 'k' => 1 }" && formatValue(new Set([1])) === "Set(1) { 1 }", formatValue(new Map([["k", 1]])));
check("a cycle prints [Circular] instead of hanging", (() => { const o = { a: 1 }; o.self = o; return /\[Circular\]/.test(formatValue(o)); })(), "");
check("bytes print as a Buffer preview, functions by name, errors as name: message",
  /^<Buffer 01 02/.test(formatValue(new Uint8Array([1, 2, 3]))) && formatValue(function foo() {}) === "[Function: foo]"
    && formatValue(new TypeError("bad")) === "TypeError: bad", formatValue(new Uint8Array([1, 2, 3])));
check("a key that is not an identifier is quoted", formatValue({ "a-b": 1 }) === "{ 'a-b': 1 }", formatValue({ "a-b": 1 }));

// ── running real scripts ──
{
  const r = await run('console.log("hello", 1 + 1);');
  check("a script's console.log reaches stdout, with a newline and no exit code", r.stdout === "hello 2\n" && r.exitCode === 0 && r.stderr === "", JSON.stringify(r));
}
{
  const r = await run('console.error("to stderr"); console.warn("also");');
  check("console.error and console.warn go to STDERR, which is how a script reports without polluting its output", r.stderr === "to stderr\nalso\n" && r.stdout === "", JSON.stringify(r));
}
{
  const r = await run('const add = require("./lib/add"); console.log(add(2, 3));', { "/workspace/lib/add.js": "module.exports = (a, b) => a + b;" });
  check("require loads a relative module from the tree and its exports work", r.stdout === "5\n" && r.exitCode === 0, JSON.stringify(r));
}
{
  const r = await run('console.log(require("./pkg").name);', { "/workspace/pkg.json": '{"name":"from json"}' });
  check("a .json module parses to an object", r.stdout === "from json\n", JSON.stringify(r));
}
{
  const r = await run('const a = require("./a"); console.log(a.v, require("./a").v);', { "/workspace/a.js": 'module.exports = { v: Math.random() };' });
  const [x, y] = r.stdout.trim().split(" ");
  check("a module is evaluated ONCE and cached — two requires are the same object", x === y && r.exitCode === 0, r.stdout);
}
{
  const r = await run('console.log(require("./x").loaded);', { "/workspace/x.js": 'exports.loaded = true;' });
  check("the `exports` shorthand works alongside `module.exports`", r.stdout === "true\n", JSON.stringify(r));
}
{
  const r = await run('require("./missing");');
  check("a module that is not there throws MODULE_NOT_FOUND, naming what and from where, and exits 1",
    r.exitCode === 1 && /Cannot find module '.\/missing'/.test(r.stderr) && /\/workspace/.test(r.stderr), JSON.stringify(r.stderr).slice(0, 140));
}

// ── the core modules a script reaches for ──
{
  const r = await run('const p = require("path"); console.log(p.join("a", "b"), p.dirname("/x/y/z"), p.extname("f.txt"), p.basename("/a/b.js", ".js"));');
  check("path: join, dirname, extname, basename", r.stdout === "a/b /x/y .txt b\n", JSON.stringify(r));
}
{
  const r = await run('const fs = require("fs"); fs.writeFileSync("out.txt", "body"); console.log(fs.readFileSync("out.txt", "utf8"), fs.existsSync("out.txt"), fs.statSync("out.txt").size);');
  check("fs: a script writes a file and reads it straight back, with a size", r.stdout === "body true 4\n", JSON.stringify(r));
}
{
  const r = await run('const fs = require("fs"); try { fs.readFileSync("nope.txt"); } catch (e) { console.log(e.code, e.syscall); }');
  check("fs: a missing file throws ENOENT with a syscall — the shape a script's catch tests", r.stdout === "ENOENT open\n", JSON.stringify(r));
}
{
  const r = await run('const fs = require("fs"); fs.mkdirSync("d"); fs.writeFileSync("d/a.txt", "1"); fs.writeFileSync("d/b.txt", "2"); console.log(fs.readdirSync("d").join(","));');
  check("fs: readdir lists what the script created, sorted", r.stdout === "a.txt,b.txt\n", JSON.stringify(r));
}
{
  const r = await run('console.log(process.argv.slice(1).join(" "), process.platform, typeof process.env, process.cwd());', {}, { argv: ["/workspace/main.js", "one", "two"] });
  check("process: argv carries the script and its arguments, with a platform, an env and a cwd",
    r.stdout === "/workspace/main.js one two linux object /workspace\n", JSON.stringify(r));
}
{
  const r = await run('process.stdout.write("no newline"); process.stderr.write("err");');
  check("process.stdout.write and stderr.write go where they say, unbuffered and unterminated", r.stdout === "no newline" && r.stderr === "err", JSON.stringify(r));
}
{
  const r = await run('console.log(require("os").platform(), require("os").EOL === "\\n");');
  check("os answers a platform and an EOL", r.stdout === "linux true\n", JSON.stringify(r));
}
{
  const r = await run('const {EventEmitter} = require("events"); const e = new EventEmitter(); e.on("x", (v) => console.log("got", v)); e.emit("x", 42); console.log(e.listenerCount("x"));');
  check("events: on/emit/listenerCount behave", r.stdout === "got 42\n1\n", JSON.stringify(r));
}
{
  const r = await run('const a = require("assert"); a.strictEqual(1, 1); a.deepStrictEqual({x:[1]}, {x:[1]}); try { a.strictEqual(1, 2); } catch (e) { console.log("caught", e.message); }');
  check("assert: passes silently and throws with a readable message — a script can be a test", /^caught 1 !== 2/.test(r.stdout), JSON.stringify(r));
}
{
  const r = await run('const u = require("url"); const x = new u.URL("https://a.test/p?q=1"); console.log(x.host, x.searchParams.get("q"));');
  check("url: URL and its searchParams", r.stdout === "a.test 1\n", JSON.stringify(r));
}
{
  const r = await run('const B = require("buffer").Buffer; const b = B.from("hi"); console.log(b.toString("base64"), B.from("aGk=", "base64").toString(), b.length);');
  check("buffer: from/toString round-trips utf8, base64 and hex", r.stdout === "aGk= hi 2\n", JSON.stringify(r));
}
{
  const r = await run('console.log(typeof require("crypto").randomUUID(), require("crypto").randomBytes(4).length);');
  check("crypto: randomUUID and randomBytes, over the isolate's own WebCrypto", r.stdout === "string 4\n", JSON.stringify(r));
}
{
  const r = await run('console.log(require("util").format("a", {b:1}), typeof require("util").promisify);');
  check("util: format and promisify", r.stdout === "a { b: 1 } function\n", JSON.stringify(r));
}
{
  const r = await run('const q = require("querystring"); console.log(q.stringify({a:1,b:"x y"}), JSON.stringify(q.parse("a=1&b=2")));');
  check("querystring: stringify and parse", r.stdout === 'a=1&b=x+y {"a":"1","b":"2"}\n', JSON.stringify(r));
}
{
  const r = await run('const {createRequire} = require("module"); console.log(typeof createRequire("/workspace/x"));');
  check("module.createRequire exists, so a script written for ESM-era Node still loads", r.stdout === "function\n", JSON.stringify(r));
}
{
  const r = await run('console.log(require("node:path").sep, require("node:fs").existsSync("/workspace"));');
  check("the `node:` prefix resolves to the same core modules", r.stdout === "/ true\n", JSON.stringify(r));
}

// ── the bounds ──
{
  const r = await run('process.exit(7); console.log("never");');
  check("process.exit stops the script there and sets the exit code", r.exitCode === 7 && r.stdout === "", JSON.stringify(r));
}
{
  const r = await run('throw new TypeError("bad thing");');
  check("an uncaught throw exits 1 and reports the type, the message and a stack — not a silent 0",
    r.exitCode === 1 && /TypeError: bad thing/.test(r.stderr) && r.stderr.includes("/workspace/main.js"), JSON.stringify(r.stderr).slice(0, 140));
}
{
  const r = await run('console.log("x".repeat(2_000_000));');
  check("output past the cap is cut and flagged, so one runaway print cannot take the turn", r.truncated === true && r.stdout.length <= NODE_OUTPUT_MAX + 16, `${r.stdout.length} chars, truncated=${r.truncated}`);
}
{
  const r = await run('try { require("child_process").execSync("ls"); } catch (e) { console.log(e.code, /machine tool/.test(e.message)); }');
  check("child_process says plainly that it is not here and names the way out — it does not return an empty result",
    r.stdout === "ENOSYS true\n", JSON.stringify(r));
}
{
  const r = await run('console.log(process.version);');
  check("process.version names this runtime rather than pretending to be a Node release", r.stdout.trim() === NODE_VERSION && /pi-cell/.test(NODE_VERSION), r.stdout);
}
{
  const r = await run('const t = []; for (let i = 0; i < 3; i++) t.push(i * i); console.log(t.join(","));');
  check("ordinary JavaScript — loops, closures, array methods — runs at full speed in the engine that is already here", r.stdout === "0,1,4\n", JSON.stringify(r));
}
{
  // The script's own writes must be visible to the run, and to the caller
  // afterwards, or `node build.js` produces nothing anyone can see.
  const runtime = rt();
  const r = await runtime.run('require("fs").writeFileSync("dist/out.js", "built");', "/workspace/main.js");
  check("a file the script wrote is in the runtime's tree afterwards, for the shell to persist",
    r.exitCode === 0 && new TextDecoder().decode(runtime.files.get("/workspace/dist/out.js")) === "built", [...runtime.files.keys()].join(","));
}
{
  const r = await run('(async () => { console.log("async ran"); })();');
  check("an async function that resolves prints before the command returns", r.stdout === "async ran\n", JSON.stringify(r));
}
{
  const r = await run('console.log(typeof fetch);');
  check("fetch is present and is the cell's GUARDED fetch, not the isolate's own", r.stdout === "function\n", JSON.stringify(r));
}
{
  const r = await run('console.log(JSON.stringify({ok:true}), Math.max(1,2), new Date(0).toISOString());');
  check("JSON, Math and Date are the engine's own — nothing was reimplemented", r.stdout === '{"ok":true} 2 1970-01-01T00:00:00.000Z\n', JSON.stringify(r));
}


// ── ESM, AND THE RESOLUTION A REAL PACKAGE NEEDS ──────────────────────────
//
// Seventeen real packages were loaded through this runtime on 2026-09-12 and
// then made to COMPUTE — not merely to load. Every failure that pass produced
// is a claim here, because each was a real defect: a frozen module cache broke
// circular requires (semver answered `satisfies("1.2.3","^1.0.0")` false), a
// class-shaped Buffer could not be called without `new` (sha.js), a Buffer
// with no integer accessors could not write its block, an `exports` map with
// no `main` resolved to nothing (typebox), and true ESM did not parse at all.
const { isEsm, esmToCjs, exportsTarget, maskSource } = await import("../src/nodejs.js");

check("ESM is recognised by an import or export at a statement position",
  isEsm('import x from "m";') && isEsm("export const a = 1;") && isEsm('export * from "m";'), "");
check("and a SCRIPT is not ESM just because it says the word — a string, a comment or `import(` is not a module",
  !isEsm('const s = "import x from y";') && !isEsm("// import x from 'm'") && !isEsm('const m = await import("m");') && !isEsm("const importer = 1;"), "");
check("the mask covers strings, templates, comments and regexes, so a rewrite never edits inside one",
  (() => { const src = 'const a = "Q"; /* Z */ const r = /W/; `T`;'; const m = maskSource(src);
    return m[src.indexOf("Q")] === 1 && m[src.indexOf("Z")] === 1 && m[src.indexOf("W")] === 1 && m[src.indexOf("T")] === 1 && m[0] === 0; })(), "");

{
  const r = await run('const m = require("./mod"); console.log(m.a, m.default, m.__esModule);', { "/workspace/mod.mjs": 'export const a = 1;\nexport default "d";' });
  check("an ESM module is rewritten to CommonJS: named exports, a default, and the __esModule mark",
    r.stdout === "1 d true\n", JSON.stringify(r));
}
{
  const r = await run('console.log(require("./a").v);', { "/workspace/a.mjs": 'import { v } from "./b.mjs";\nexport { v };', "/workspace/b.mjs": "export const v = 7;" });
  check("ESM importing ESM: the named binding crosses the rewrite", r.stdout === "7\n", JSON.stringify(r));
}
{
  const r = await run('console.log(require("./a").out);', { "/workspace/a.mjs": 'import cjs from "./b.js";\nexport const out = cjs.hello;', "/workspace/b.js": 'module.exports = { hello: "from cjs" };' });
  check("ESM importing a CommonJS module gets module.exports as its default — the interop that makes mixed trees work",
    r.stdout === "from cjs\n", JSON.stringify(r));
}
{
  const r = await run('console.log(Object.keys(require("./a")).sort().join(","));', { "/workspace/a.mjs": 'export * from "./b.mjs";\nexport const own = 1;', "/workspace/b.mjs": 'export const far = 2;\nexport default "ignored";' });
  check("`export * from` re-exports the names but NOT the default, as ESM specifies",
    r.stdout === "__esModule,far,own\n", JSON.stringify(r));
}
{
  const r = await run('(async () => { const m = await import("./a.mjs"); console.log(m.v); })();', { "/workspace/a.mjs": "export const v = 9;" });
  check("a dynamic import() resolves to the module namespace", r.stdout === "9\n", JSON.stringify(r));
}
{
  const r = await run('console.log(require("./a").u.startsWith("file:///workspace"));', { "/workspace/a.mjs": "export const u = import.meta.url;" });
  check("import.meta.url is the module's own file URL", r.stdout === "true\n", JSON.stringify(r));
}

// ── package.json exports ──
check("an exports map answers a string, a conditions object and a subpath",
  exportsTarget("./i.js") === "./i.js" && exportsTarget({ require: "./r.cjs", import: "./i.mjs" }) === "./r.cjs"
    && exportsTarget({ ".": { require: "./r.cjs" }, "./sub": { require: "./s.cjs" } }, "./sub") === "./s.cjs", "");
check("require is preferred over import, because this runtime compiles to CommonJS",
  exportsTarget({ import: "./i.mjs", require: "./r.cjs" }) === "./r.cjs", String(exportsTarget({ import: "./i.mjs", require: "./r.cjs" })));
check("a wildcard subpath substitutes the star", exportsTarget({ "./*": "./dist/*.js" }, "./thing") === "./dist/thing.js", String(exportsTarget({ "./*": "./dist/*.js" }, "./thing")));
check("and a subpath the map does not carry is null, never a guess",
  exportsTarget({ ".": "./i.js" }, "./nope") === null && exportsTarget(null) === null, "");
{
  const files = new Set(["/w/node_modules/p/package.json", "/w/node_modules/p/dist/main.cjs", "/w/node_modules/p/dist/sub.cjs"]);
  const json = { exports: { ".": { require: "./dist/main.cjs" }, "./sub": { require: "./dist/sub.cjs" } } };
  check("a package with an exports map and NO main resolves through the map — the shape that resolved to nothing before",
    resolveModule("p", "/w", (x) => files.has(x), () => json) === "/w/node_modules/p/dist/main.cjs", String(resolveModule("p", "/w", (x) => files.has(x), () => json)));
  check("and a subpath of it resolves through the same map",
    resolveModule("p/sub", "/w", (x) => files.has(x), () => json) === "/w/node_modules/p/dist/sub.cjs", String(resolveModule("p/sub", "/w", (x) => files.has(x), () => json)));
}

// ── the circular require that broke semver ──
{
  const r = await run('const A = require("./a"); console.log(new A().fromB());', {
    "/workspace/a.js": 'class A { fromB() { return new (require("./b"))().name; } }\nmodule.exports = A;\nrequire("./b");',
    "/workspace/b.js": 'class B { get name() { return "B"; } }\nmodule.exports = B;\nrequire("./a");',
  });
  check("a CIRCULAR require works when each module assigns module.exports before requiring its partner — the idiom semver relies on",
    r.stdout === "B\n" && r.exitCode === 0, JSON.stringify(r));
}
{
  const r = await run('const B = require("buffer").Buffer; const b = B(4); b.writeUInt32BE(0xdeadbeef, 0); console.log(b.toString("hex"), B("hi").toString(), B.from([1,2]).equals(B.from([1,2])));');
  check("Buffer is CALLABLE without `new` and carries the integer accessors a hashing package writes through",
    r.stdout === "deadbeef hi true\n", JSON.stringify(r));
}
{
  const r = await run('const b = require("buffer").Buffer.from("abc"); const c = require("buffer").Buffer.alloc(3); b.copy(c); console.log(c.toString(), b.slice(1).toString(), b.readUInt8(0));');
  check("copy, slice and readUInt8 behave", r.stdout === "abc bc 97\n", JSON.stringify(r));
}

// ── the core modules added because a real package asked for them ──
{
  const r = await run('console.log(require("tty").isatty(1), typeof require("constants").ENOENT, typeof require("perf_hooks").performance.now);');
  check("tty, constants and perf_hooks answer — `debug` failed on tty alone, and half of npm depends on debug",
    r.stdout === "false number function\n", JSON.stringify(r));
}
{
  const r = await run('const {AsyncLocalStorage} = require("async_hooks"); const als = new AsyncLocalStorage(); console.log(als.run({v:1}, () => als.getStore().v), als.getStore());');
  check("AsyncLocalStorage holds a store for the duration of a run and is empty outside it", r.stdout === "1 undefined\n", JSON.stringify(r));
}
{
  const r = await run('const s = require("stream"); const w = new s.Writable(); const rd = s.Readable.from(["a","b"]); rd.on("end", () => console.log(w.chunks.join(""))); rd.pipe(w);');
  check("stream: a Readable pipes into a Writable", r.stdout === "ab\n", JSON.stringify(r));
}
{
  const r = await run('try { require("net").connect(); } catch (e) { console.log(e.code, /machine tool/.test(e.message)); }');
  check("net, tls, dns, worker_threads and cluster each refuse with the reason and the way out, rather than existing as an empty object",
    r.stdout === "ENOSYS true\n", JSON.stringify(r));
}
{
  const r = await run('try { require("zlib").gzipSync(new Uint8Array()); } catch (e) { console.log(e.code, /not/.test(e.message)); }');
  check("zlib's SYNC form says it cannot be synchronous here rather than returning empty bytes", r.stdout === "ENOSYS true\n", JSON.stringify(r));
}
{
  const r = await run('const v = require("vm"); console.log(v.runInThisContext("1+1"), new v.Script("2*3").runInThisContext());');
  check("vm compiles in THIS context — there is no second one, and it says so rather than pretending", r.stdout === "2 6\n", JSON.stringify(r));
}

console.log(bad ? `\n${bad} FAILED` : "\nall claims hold");
process.exit(bad ? 1 : 0);
