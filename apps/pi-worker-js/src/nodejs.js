// `node` IN THE CELL — because the cell already IS a JavaScript runtime.
//
// The obvious way to run JS without a machine is to ship an interpreter:
// QuickJS as WebAssembly, a megabyte of wasm, every call crossing a boundary.
// That is not needed here. Measured on a live cell 2026-09-11 with a probe
// route: `new Function("return 1+1")()` → 2, `eval("2+3")` → 5,
// `WebAssembly.Instance` → 7, and `navigator.userAgent` → "Cloudflare-Workers".
// The isolate permits dynamic evaluation. So `node script.js` is: read the
// file out of the cell's tree, wrap it as a CommonJS module, and hand it to
// the engine that is already running.
//
// WHAT THIS IS NOT. There is no libuv, no sockets, no threads, no native
// addons, no npm. `fs` is the cell's in-memory tree, `child_process` is
// just-bash, and anything that needs a file descriptor or a real process does
// not exist. The point is the enormous middle: a script that parses JSON,
// walks a tree, transforms text, does arithmetic, formats a report, runs a
// test — the work a model actually writes JavaScript for.
//
// THE SANDBOX IS HONEST ABOUT ITSELF. The script runs in this isolate, which
// is the security boundary: one per session, no host filesystem, no ambient
// Kortix credential (the cell keeps those in module scope, out of reach of a
// function compiled at global scope). What the wrapper CAN do is shadow the
// dangerous globals — `fetch` becomes the same guarded fetch the shell's curl
// uses, so a script cannot reach a private address that `curl` is refused. A
// determined script can still reconstruct the real global through the engine;
// this narrows the accident, not the adversary, and the model that writes the
// script is the same one that already has the shell.
import { isTypeScript, stripTypes } from "./typescript.js";
import { CELL_CWD } from "./execenv.cell.js";

/** How long a script may run, and how much it may print. */
export const NODE_TIMEOUT_MS = 30_000;
export const NODE_OUTPUT_MAX = 1_000_000;
export const NODE_VERSION = "v22.0.0-pi-cell";

const dirnameOf = (p) => { const i = p.lastIndexOf("/"); return i <= 0 ? "/" : p.slice(0, i); };
const basenameOf = (p) => p.slice(p.lastIndexOf("/") + 1);
const extnameOf = (p) => { const b = basenameOf(p); const i = b.lastIndexOf("."); return i > 0 ? b.slice(i) : ""; };

/** POSIX path.resolve over a cwd — the one piece every other path op needs. */
export function resolvePath(cwd, ...parts) {
  let out = cwd || "/";
  for (const part of parts) {
    const p = String(part ?? "");
    if (!p) continue;
    out = p.startsWith("/") ? p : `${out}/${p}`;
  }
  const stack = [];
  for (const seg of out.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { stack.pop(); continue; }
    stack.push(seg);
  }
  return `/${stack.join("/")}`;
}

/** path.relative, for the same reason. */
export function relativePath(from, to) {
  const a = resolvePath("/", from).split("/").filter(Boolean);
  const b = resolvePath("/", to).split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...Array(a.length - i).fill(".."), ...b.slice(i)].join("/");
}

/**
 * WHERE `require(x)` LOOKS, in Node's own order.
 *
 * A relative or absolute specifier is a file, then a file with `.js`/`.json`
 * appended, then a directory (its package.json `main`, then `index.js`). A
 * bare specifier walks `node_modules` up from the requiring file — which
 * exists in a cell whenever the project's checkout carries one.
 *
 * Pure over a `has(path)` predicate and a `readJson`, so the whole resolution
 * order is asserted without a filesystem.
 */
/**
 * One target out of a package's `exports` map, for a subpath.
 *
 * The map is a string, a conditions object, or a subpath object whose values
 * are either. Conditions are tried in the order a CommonJS loader tries them:
 * `require` before `import`, because this runtime compiles to CommonJS and an
 * ESM-only branch is the one more likely to need a rewrite.
 */
export function exportsTarget(exp, subpath = ".") {
  const pick = (node, depth = 0) => {
    if (depth > 8) return null;
    if (typeof node === "string") return node;
    if (!node || typeof node !== "object") return null;
    if (Array.isArray(node)) { for (const x of node) { const v = pick(x, depth + 1); if (v) return v; } return null; }
    for (const cond of ["require", "node", "default", "import", "module"]) {
      if (cond in node) { const v = pick(node[cond], depth + 1); if (v) return v; }
    }
    return null;
  };
  if (typeof exp === "string") return subpath === "." ? exp : null;
  if (!exp || typeof exp !== "object") return null;
  // A map with no "." and no subpath keys is a bare conditions object.
  const hasSubpaths = Object.keys(exp).some((k) => k.startsWith("."));
  if (!hasSubpaths) return subpath === "." ? pick(exp) : null;
  if (subpath in exp) return pick(exp[subpath]);
  // A wildcard subpath: "./*": "./dist/*.js"
  for (const [k, v] of Object.entries(exp)) {
    if (!k.includes("*")) continue;
    const [pre, post] = k.split("*");
    if (!subpath.startsWith(pre) || !subpath.endsWith(post)) continue;
    const star = subpath.slice(pre.length, subpath.length - (post.length || 0));
    const target = pick(v);
    if (target) return target.split("*").join(star);
  }
  return null;
}

export function resolveModule(spec, fromDir, has, readJson) {
  const candidates = [];
  const asFile = (base) => {
    candidates.push(base, `${base}.js`, `${base}.json`, `${base}.mjs`, `${base}.cjs`, `${base}.ts`, `${base}.mts`, `${base}.cts`);
    // TYPESCRIPT IMPORTS THE FILE IT WILL BECOME, not the file on disk:
    // `from "./manager.js"` in a .ts file means manager.ts. Node resolves this
    // too, and without it a TypeScript project's own imports all miss.
    const swap = { ".js": ".ts", ".mjs": ".mts", ".cjs": ".cts" };
    for (const [from, to] of Object.entries(swap)) if (base.endsWith(from)) candidates.push(base.slice(0, -from.length) + to);
  };
  const asDir = (base) => {
    const pkg = `${base}/package.json`;
    if (has(pkg)) {
      const json = readJson(pkg);
      // THE `exports` MAP FIRST, because a modern package has no `main` at all
      // and answering with index.js is answering with a file it does not ship.
      // Measured 2026-09-12: typebox resolved to nothing for exactly this.
      const viaExports = exportsTarget(json?.exports, ".");
      if (viaExports) asFile(resolvePath(base, viaExports));
      const main = json?.main;
      if (typeof main === "string" && main) asFile(resolvePath(base, main));
    }
    candidates.push(`${base}/index.js`, `${base}/index.json`, `${base}/index.ts`, `${base}/index.mts`);
  };
  if (spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/")) {
    const base = resolvePath(fromDir, spec);
    asFile(base);
    asDir(base);
  } else {
    // A bare specifier may name a SUBPATH: `pkg/sub`, which the package's own
    // `exports` map may redirect. The package root is the first segment (two
    // for a scope).
    const segs = spec.split("/");
    const pkgName = spec.startsWith("@") ? segs.slice(0, 2).join("/") : segs[0];
    const sub = spec.slice(pkgName.length);
    let dir = fromDir;
    for (;;) {
      const root = resolvePath(dir, "node_modules", pkgName);
      if (sub && has(`${root}/package.json`)) {
        const t = exportsTarget(readJson(`${root}/package.json`)?.exports, `.${sub}`);
        if (t) asFile(resolvePath(root, t));
      }
      const base = resolvePath(dir, "node_modules", spec);
      asFile(base);
      asDir(base);
      const up = dirnameOf(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  for (const c of candidates) if (has(c)) return c;
  return null;
}

/** `console.log`'s formatting, close enough to read a script's output by. */
export function formatValue(v, seen = new Set(), depth = 0) {
  if (typeof v === "string") return depth === 0 ? v : `'${v}'`;
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "function") return `[Function: ${v.name || "anonymous"}]`;
  if (typeof v === "symbol") return String(v);
  if (v === null || v === undefined || typeof v !== "object") return String(v);
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  if (seen.has(v)) return "[Circular]";
  if (depth > 4) return Array.isArray(v) ? "[Array]" : "[Object]";
  seen.add(v);
  try {
    if (Array.isArray(v)) return `[ ${v.map((x) => formatValue(x, seen, depth + 1)).join(", ")} ]`;
    if (v instanceof Map) return `Map(${v.size}) { ${[...v].map(([k, x]) => `${formatValue(k, seen, depth + 1)} => ${formatValue(x, seen, depth + 1)}`).join(", ")} }`;
    if (v instanceof Set) return `Set(${v.size}) { ${[...v].map((x) => formatValue(x, seen, depth + 1)).join(", ")} }`;
    if (v instanceof Date) return v.toISOString();
    if (v instanceof Uint8Array) return `<Buffer ${[...v.subarray(0, 24)].map((b) => b.toString(16).padStart(2, "0")).join(" ")}${v.length > 24 ? " ..." : ""}>`;
    const entries = Object.entries(v).map(([k, x]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k}'`}: ${formatValue(x, seen, depth + 1)}`);
    const name = v.constructor && v.constructor.name !== "Object" ? `${v.constructor.name} ` : "";
    return entries.length ? `${name}{ ${entries.join(", ")} }` : `${name}{}`;
  } finally { seen.delete(v); }
}

/**
 * The runtime: a CommonJS loader plus the core modules, over the cell's tree.
 *
 * `fsApi` is the small async surface the cell's filesystem exposes. Node's own
 * `fs` is synchronous, and an in-memory tree CAN be read synchronously — but
 * not through a promise. So the loader PRELOADS: every file the script
 * requires is read before it is evaluated, and `fs.readFileSync` serves from
 * that cache plus anything the script itself wrote. A read of a file that was
 * never loaded and never written throws ENOENT, which is the honest answer:
 * this runtime cannot block on a promise.
 */
export function createNodeRuntime({ fs, cwd = CELL_CWD, argv = [], env = {}, fetch: guardedFetch, now = Date.now, timeoutMs = NODE_TIMEOUT_MS }) {
  let out = "", err = "", truncated = false;
  const write = (which, s) => {
    // THE CAP APPLIES TO THIS WRITE, NOT ONLY TO WHAT CAME BEFORE IT. Checking
    // the total first and then appending whole let a single
    // `console.log("x".repeat(2e6))` through — the exact shape the cap exists
    // for (caught by its own claim, 2026-09-12).
    const room = NODE_OUTPUT_MAX - (out.length + err.length);
    if (room <= 0) { truncated = true; return; }
    let text = String(s);
    if (text.length > room) { text = text.slice(0, room); truncated = true; }
    if (which === "out") out += text; else err += text;
  };
  // The tree as this run sees it: preloaded reads, plus the script's writes.
  const files = new Map();     // absolute path -> Uint8Array
  const dirs = new Set(["/", cwd]);
  const enc = new TextEncoder(), dec = new TextDecoder();
  const has = (p) => files.has(p);
  const readJson = (p) => { try { return JSON.parse(dec.decode(files.get(p))); } catch { return null; } };

  const ENOENT = (p, syscall = "open") => Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${p}'`), { code: "ENOENT", errno: -2, syscall, path: p });

  const pathMod = {
    sep: "/", delimiter: ":",
    resolve: (...p) => resolvePath(cwd, ...p),
    join: (...p) => { const j = p.filter((x) => x !== "").join("/"); return j.startsWith("/") ? resolvePath("/", j) : resolvePath("/", j).slice(1) || "."; },
    normalize: (p) => (p.startsWith("/") ? resolvePath("/", p) : resolvePath("/", p).slice(1) || "."),
    dirname: dirnameOf, basename: (p, ext) => { const b = basenameOf(p); return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b; },
    extname: extnameOf, isAbsolute: (p) => String(p).startsWith("/"),
    relative: relativePath,
    parse: (p) => ({ root: p.startsWith("/") ? "/" : "", dir: dirnameOf(p), base: basenameOf(p), ext: extnameOf(p), name: basenameOf(p).replace(/\.[^.]+$/, "") }),
    format: (o) => `${o.dir ? `${o.dir}/` : ""}${o.base ?? `${o.name ?? ""}${o.ext ?? ""}`}`,
    posix: null,
  };
  pathMod.posix = pathMod;

  const fsMod = {
    readFileSync(p, opt) {
      const abs = resolvePath(cwd, p);
      if (!files.has(abs)) throw ENOENT(abs);
      const bytes = files.get(abs);
      const encoding = typeof opt === "string" ? opt : opt?.encoding;
      return encoding ? dec.decode(bytes) : bytes;
    },
    writeFileSync(p, data) { const abs = resolvePath(cwd, p); files.set(abs, typeof data === "string" ? enc.encode(data) : new Uint8Array(data)); dirs.add(dirnameOf(abs)); },
    appendFileSync(p, data) { const abs = resolvePath(cwd, p); const old = files.get(abs) ?? new Uint8Array(); const add = typeof data === "string" ? enc.encode(data) : new Uint8Array(data); const j = new Uint8Array(old.length + add.length); j.set(old); j.set(add, old.length); files.set(abs, j); },
    existsSync(p) { const abs = resolvePath(cwd, p); return files.has(abs) || dirs.has(abs); },
    mkdirSync(p) { dirs.add(resolvePath(cwd, p)); },
    unlinkSync(p) { files.delete(resolvePath(cwd, p)); },
    rmSync(p) { const abs = resolvePath(cwd, p); files.delete(abs); dirs.delete(abs); },
    readdirSync(p) {
      const abs = resolvePath(cwd, p);
      const names = new Set();
      for (const f of files.keys()) if (dirnameOf(f) === abs) names.add(basenameOf(f));
      for (const d of dirs) if (d !== abs && dirnameOf(d) === abs) names.add(basenameOf(d));
      if (!names.size && !dirs.has(abs)) throw ENOENT(abs, "scandir");
      return [...names].sort();
    },
    statSync(p) {
      const abs = resolvePath(cwd, p);
      if (files.has(abs)) { const b = files.get(abs); return { isFile: () => true, isDirectory: () => false, size: b.length, mtimeMs: now() }; }
      if (dirs.has(abs)) return { isFile: () => false, isDirectory: () => true, size: 0, mtimeMs: now() };
      throw ENOENT(abs, "stat");
    },
  };
  fsMod.promises = {
    readFile: async (p, o) => fsMod.readFileSync(p, o),
    writeFile: async (p, d) => fsMod.writeFileSync(p, d),
    appendFile: async (p, d) => fsMod.appendFileSync(p, d),
    mkdir: async (p) => fsMod.mkdirSync(p),
    readdir: async (p) => fsMod.readdirSync(p),
    stat: async (p) => fsMod.statSync(p),
    rm: async (p) => fsMod.rmSync(p),
    unlink: async (p) => fsMod.unlinkSync(p),
  };

  let exitCode = null;
  const processMod = {
    argv: ["node", ...argv], argv0: "node", execPath: "/usr/local/bin/node",
    env: { ...env }, platform: "linux", arch: "x64", version: NODE_VERSION,
    versions: { node: NODE_VERSION.replace(/^v/, ""), v8: "pi-cell" },
    pid: 1, ppid: 0, cwd: () => cwd, chdir: () => { throw new Error("process.chdir is not supported in a cell"); },
    exit: (code = 0) => { exitCode = Number(code) || 0; throw { __nodeExit: exitCode }; },
    hrtime: Object.assign((prev) => { const ms = now(); const s = Math.floor(ms / 1000), ns = Math.floor((ms % 1000) * 1e6); return prev ? [s - prev[0], ns - prev[1]] : [s, ns]; }, { bigint: () => BigInt(Math.floor(now() * 1e6)) }),
    uptime: () => 0, memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }),
    nextTick: (fn, ...a) => queueMicrotask(() => fn(...a)),
    on: () => processMod, once: () => processMod, emit: () => false, exitCode: 0,
    stdout: { write: (s) => { write("out", s); return true; }, isTTY: false, columns: 80 },
    stderr: { write: (s) => { write("err", s); return true; }, isTTY: false },
    stdin: { isTTY: false, read: () => null, on: () => {}, setEncoding: () => {} },
  };

  const consoleMod = {
    log: (...a) => write("out", `${a.map((x) => formatValue(x)).join(" ")}\n`),
    info: (...a) => write("out", `${a.map((x) => formatValue(x)).join(" ")}\n`),
    debug: (...a) => write("out", `${a.map((x) => formatValue(x)).join(" ")}\n`),
    warn: (...a) => write("err", `${a.map((x) => formatValue(x)).join(" ")}\n`),
    error: (...a) => write("err", `${a.map((x) => formatValue(x)).join(" ")}\n`),
    trace: (...a) => write("err", `Trace: ${a.map((x) => formatValue(x)).join(" ")}\n`),
    table: (v) => write("out", `${formatValue(v)}\n`),
    dir: (v) => write("out", `${formatValue(v)}\n`),
    group: () => {}, groupEnd: () => {}, time: () => {}, timeEnd: () => {}, assert: () => {},
    count: () => {}, countReset: () => {},
  };

  class EventEmitter {
    constructor() { this._e = new Map(); }
    on(n, f) { (this._e.get(n) ?? this._e.set(n, []).get(n)).push(f); return this; }
    addListener(n, f) { return this.on(n, f); }
    once(n, f) { const g = (...a) => { this.off(n, g); f(...a); }; return this.on(n, g); }
    off(n, f) { const l = this._e.get(n); if (l) this._e.set(n, l.filter((x) => x !== f)); return this; }
    removeListener(n, f) { return this.off(n, f); }
    removeAllListeners(n) { if (n) this._e.delete(n); else this._e.clear(); return this; }
    emit(n, ...a) { const l = this._e.get(n) ?? []; for (const f of [...l]) f(...a); return l.length > 0; }
    listenerCount(n) { return (this._e.get(n) ?? []).length; }
    listeners(n) { return [...(this._e.get(n) ?? [])]; }
  }

  const inspect = (v, o) => formatValue(v, new Set(), o?.depth === null ? 0 : 1);
  const core = new Map();
  const define = (name, mod) => { core.set(name, mod); core.set(`node:${name}`, mod); };
  define("path", pathMod);
  define("fs", fsMod);
  define("os", { EOL: "\n", platform: () => "linux", arch: () => "x64", type: () => "Linux", release: () => "pi-cell", homedir: () => cwd, tmpdir: () => "/tmp", hostname: () => "cell", cpus: () => [], totalmem: () => 0, freemem: () => 0, uptime: () => 0, endianness: () => "LE" });
  define("util", {
    inspect, format: (...a) => a.map((x) => formatValue(x)).join(" "),
    promisify: (fn) => (...a) => new Promise((res, rej) => fn(...a, (e, v) => (e ? rej(e) : res(v)))),
    callbackify: (fn) => (...a) => { const cb = a.pop(); fn(...a).then((v) => cb(null, v), cb); },
    types: { isDate: (v) => v instanceof Date, isRegExp: (v) => v instanceof RegExp },
    deprecate: (fn) => fn, inherits: (c, s) => { Object.setPrototypeOf(c.prototype, s.prototype); },
    isArray: Array.isArray, isDeepStrictEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    TextEncoder, TextDecoder,
  });
  define("events", Object.assign(EventEmitter, { EventEmitter, once: (em, n) => new Promise((r) => em.once(n, (...a) => r(a))), default: EventEmitter }));
  define("assert", Object.assign(
    function assert(v, m) { if (!v) throw Object.assign(new Error(m ?? "Assertion failed"), { code: "ERR_ASSERTION" }); },
    {
      ok(v, m) { if (!v) throw Object.assign(new Error(m ?? "Assertion failed"), { code: "ERR_ASSERTION" }); },
      equal(a, b, m) { if (a != b) throw new Error(m ?? `${formatValue(a)} != ${formatValue(b)}`); },
      strictEqual(a, b, m) { if (a !== b) throw new Error(m ?? `${formatValue(a)} !== ${formatValue(b)}`); },
      notStrictEqual(a, b, m) { if (a === b) throw new Error(m ?? `${formatValue(a)} === ${formatValue(b)}`); },
      deepStrictEqual(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(m ?? `${formatValue(a)} deepStrictEqual ${formatValue(b)}`); },
      deepEqual(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(m ?? "not deep equal"); },
      throws(fn, _e, m) { let threw = false; try { fn(); } catch { threw = true; } if (!threw) throw new Error(m ?? "Missing expected exception"); },
      fail(m) { throw new Error(m ?? "Failed"); },
    },
  ));
  define("url", { URL, URLSearchParams, fileURLToPath: (u) => new URL(u).pathname, pathToFileURL: (p) => new URL(`file://${p}`) });
  define("querystring", {
    parse: (s) => Object.fromEntries(new URLSearchParams(s)),
    stringify: (o) => new URLSearchParams(o).toString(),
  });
  define("string_decoder", { StringDecoder: class { write(b) { return dec.decode(b, { stream: true }); } end() { return ""; } } });
  define("timers", { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate: (f, ...a) => setTimeout(f, 0, ...a) });
  define("crypto", {
    randomUUID: () => globalThis.crypto.randomUUID(),
    getRandomValues: (a) => globalThis.crypto.getRandomValues(a),
    webcrypto: globalThis.crypto,
    randomBytes: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
  });
  define("buffer", { Buffer: BufferShim() });
  define("process", processMod);
  define("console", consoleMod);
  define("module", { createRequire: () => (s) => requireFrom(cwd)(s) });
  // MEASURED ADDITIONS (2026-09-12). `debug` — a dependency of half of npm —
  // failed on `tty` alone. These are the rest of the surface a pure-JS package
  // touches, each answering honestly: the ones a cell HAS are real, and the
  // ones it cannot have throw with the reason and the way out.
  define("tty", { isatty: () => false, ReadStream: class {}, WriteStream: class {} });
  {
    // AsyncLocalStorage without async hooks: the isolate runs one turn at a
    // time, so a store held for the duration of `run` is observed by exactly
    // the code the real one would reach. `just-bash` itself needs this.
    class AsyncLocalStorage {
      constructor() { this._store = undefined; }
      run(store, fn, ...a) { const prev = this._store; this._store = store; try { return fn(...a); } finally { this._store = prev; } }
      getStore() { return this._store; }
      enterWith(store) { this._store = store; }
      exit(fn, ...a) { return this.run(undefined, fn, ...a); }
      disable() { this._store = undefined; }
    }
    define("async_hooks", { AsyncLocalStorage, AsyncResource: class { runInAsyncScope(fn, self, ...a) { return fn.apply(self, a); } }, executionAsyncId: () => 0, createHook: () => ({ enable: () => {}, disable: () => {} }) });
  }
  define("constants", { E2BIG: 7, EACCES: 13, EEXIST: 17, EISDIR: 21, ENOENT: 2, ENOTDIR: 20, EPERM: 1, O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_APPEND: 1024 });
  define("perf_hooks", { performance: globalThis.performance ?? { now: () => now() } });
  define("v8", { serialize: (v) => enc.encode(JSON.stringify(v)), deserialize: (b) => JSON.parse(dec.decode(b)) });
  define("vm", {
    // The isolate compiles code; there is no separate context to run it in, so
    // `runInNewContext` runs in THIS one. Said here rather than discovered.
    runInThisContext: (code) => new Function(`return (${code})`)(),
    runInNewContext: (code) => new Function(`return (${code})`)(),
    createContext: (o) => o ?? {},
    Script: class { constructor(code) { this.code = code; } runInThisContext() { return new Function(`return (${this.code})`)(); } },
  });
  {
    // A minimal stream: enough for a package that pipes text, not a
    // replacement for libuv's. `Readable.from` and the event shape are what
    // the common cases reach for.
    class Stream extends EventEmitter {
      pipe(dest) { this.on("data", (c) => dest.write(c)); this.on("end", () => dest.end?.()); return dest; }
    }
    class Readable extends Stream {
      constructor(opts) { super(); this._chunks = []; this._read = opts?.read; }
      push(c) { if (c === null) { queueMicrotask(() => this.emit("end")); return false; } this._chunks.push(c); queueMicrotask(() => this.emit("data", c)); return true; }
      setEncoding() { return this; }
      static from(iter) { const r = new Readable(); queueMicrotask(async () => { for await (const c of iter) r.push(c); r.push(null); }); return r; }
    }
    class Writable extends Stream {
      constructor(opts) { super(); this.chunks = []; this._write = opts?.write; }
      write(c) { this.chunks.push(c); this._write?.(c, null, () => {}); this.emit("data", c); return true; }
      end(c) { if (c !== undefined) this.write(c); this.emit("finish"); this.emit("end"); return this; }
    }
    class Transform extends Writable {}
    class PassThrough extends Transform {}
    define("stream", Object.assign(Stream, { Stream, Readable, Writable, Transform, PassThrough, pipeline: (...a) => { const cb = a.pop(); try { a.reduce((x, y) => x.pipe(y)); cb?.(null); } catch (e) { cb?.(e); } }, finished: (s, cb) => s.on("end", () => cb?.(null)) }));
    define("stream/promises", { pipeline: async (...a) => { a.reduce((x, y) => x.pipe(y)); } });
  }
  {
    // zlib over the engine's OWN compression streams, which a Workers-shaped
    // isolate has. Async only: there is no way to block on a stream here, and
    // a `gzipSync` that returned empty bytes would be worse than one that says
    // it is not available.
    const through = async (bytes, format, mode) => {
      const S = mode === "compress" ? globalThis.CompressionStream : globalThis.DecompressionStream;
      if (!S) throw Object.assign(new Error(`zlib: this runtime has no ${mode}ion stream`), { code: "ENOSYS" });
      const stream = new Blob([bytes]).stream().pipeThrough(new S(format));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    };
    const cb = (fn) => (buf, opts, callback) => { const done = typeof opts === "function" ? opts : callback; fn(buf).then((v) => done(null, v), done); };
    const notSync = (name) => () => { throw Object.assign(new Error(`zlib.${name} is synchronous and this runtime's compression is not — use the callback or promise form`), { code: "ENOSYS" }); };
    define("zlib", {
      gzip: cb((b) => through(b, "gzip", "compress")), gunzip: cb((b) => through(b, "gzip", "decompress")),
      deflate: cb((b) => through(b, "deflate", "compress")), inflate: cb((b) => through(b, "deflate", "decompress")),
      brotliDecompress: cb((b) => through(b, "deflate", "decompress")),
      gzipSync: notSync("gzipSync"), gunzipSync: notSync("gunzipSync"), inflateSync: notSync("inflateSync"), deflateSync: notSync("deflateSync"),
      constants: {},
    });
  }
  {
    // `http` over the guarded fetch: a package that GETs a URL works; one that
    // listens does not, and says so.
    const request = (url, opts, cb) => {
      const callback = typeof opts === "function" ? opts : cb;
      const em = new EventEmitter();
      const target = typeof url === "string" ? url : `${url.protocol ?? "https:"}//${url.host ?? url.hostname}${url.path ?? "/"}`;
      queueMicrotask(async () => {
        try {
          const r = await guardedFetch(target, { method: (typeof opts === "object" ? opts?.method : null) ?? "GET" });
          const res = new EventEmitter();
          res.statusCode = r.status; res.headers = Object.fromEntries(r.headers ?? []);
          res.setEncoding = () => res;
          callback?.(res);
          const body = r.body instanceof Uint8Array ? r.body : new Uint8Array(await (r.arrayBuffer?.() ?? new ArrayBuffer(0)));
          res.emit("data", dec.decode(body)); res.emit("end");
        } catch (e) { em.emit("error", e); }
      });
      em.end = () => em; em.write = () => true; em.setTimeout = () => em;
      return em;
    };
    const mod = { request, get: request, createServer: () => { throw Object.assign(new Error("a cell cannot listen on a port — use the machine tool for a real box"), { code: "ENOSYS" }); }, Agent: class {}, STATUS_CODES: {} };
    define("http", mod); define("https", mod);
  }
  for (const [name, why] of [["net", "sockets"], ["tls", "sockets"], ["dgram", "sockets"], ["dns", "name resolution"], ["worker_threads", "threads"], ["cluster", "processes"], ["repl", "a terminal"]]) {
    define(name, new Proxy({}, { get() { throw Object.assign(new Error(`${name} needs ${why}, which a cell does not have — use the machine tool for a real box`), { code: "ENOSYS" }); } }));
  }
  define("child_process", {
    // The cell HAS a shell — just-bash — but this runtime cannot await it from
    // a synchronous require graph, and `execSync` is what a script reaches for.
    // Saying so beats returning an empty string that reads as a command with
    // no output.
    execSync() { throw Object.assign(new Error("child_process is not available inside `node` in a cell — run the command in the shell instead, or use the machine tool for a real box"), { code: "ENOSYS" }); },
    exec() { throw Object.assign(new Error("child_process is not available inside `node` in a cell"), { code: "ENOSYS" }); },
    spawnSync() { throw Object.assign(new Error("child_process is not available inside `node` in a cell"), { code: "ENOSYS" }); },
  });

  function BufferShim() {
    // CALLABLE WITHOUT `new`. Node's Buffer is a function, and older packages
    // still call `Buffer(x)` — sha.js does, and a class threw "Class
    // constructor B cannot be invoked without 'new'" on every digest
    // (measured 2026-09-12).
    class B extends Uint8Array {
      static from(v, e) {
        if (typeof v === "string") return new B(e === "base64" ? Uint8Array.from(atob(v), (c) => c.charCodeAt(0)) : e === "hex" ? Uint8Array.from(v.match(/../g) ?? [], (h) => parseInt(h, 16)) : enc.encode(v));
        return new B(Uint8Array.from(v));
      }
      static alloc(n, fill = 0) { const b = new B(n); b.fill(fill); return b; }
      static concat(list) { const total = list.reduce((a, x) => a + x.length, 0); const b = new B(total); let o = 0; for (const x of list) { b.set(x, o); o += x.length; } return b; }
      static isBuffer(v) { return v instanceof B; }
      static byteLength(s) { return typeof s === "string" ? enc.encode(s).length : s.length; }
      toString(e = "utf8", start, end) {
        const view = start !== undefined || end !== undefined ? this.subarray(start ?? 0, end ?? this.length) : this;
        if (e === "base64") { let s = ""; for (const c of view) s += String.fromCharCode(c); return btoa(s); }
        if (e === "hex") return [...view].map((c) => c.toString(16).padStart(2, "0")).join("");
        if (e === "latin1" || e === "binary") { let s = ""; for (const c of view) s += String.fromCharCode(c); return s; }
        return dec.decode(view);
      }
      // THE INTEGER ACCESSORS. A hashing package writes its block through
      // these, not through index assignment — sha.js digests died on
      // "this._block.writeUInt32BE is not a function" (measured 2026-09-12).
      get _dv() { return new DataView(this.buffer, this.byteOffset, this.byteLength); }
      writeUInt32BE(v, o = 0) { this._dv.setUint32(o, v >>> 0, false); return o + 4; }
      writeUInt32LE(v, o = 0) { this._dv.setUint32(o, v >>> 0, true); return o + 4; }
      readUInt32BE(o = 0) { return this._dv.getUint32(o, false); }
      readUInt32LE(o = 0) { return this._dv.getUint32(o, true); }
      writeInt32BE(v, o = 0) { this._dv.setInt32(o, v, false); return o + 4; }
      readInt32BE(o = 0) { return this._dv.getInt32(o, false); }
      writeUInt16BE(v, o = 0) { this._dv.setUint16(o, v, false); return o + 2; }
      readUInt16BE(o = 0) { return this._dv.getUint16(o, false); }
      writeUInt8(v, o = 0) { this[o] = v & 0xff; return o + 1; }
      readUInt8(o = 0) { return this[o]; }
      writeDoubleBE(v, o = 0) { this._dv.setFloat64(o, v, false); return o + 8; }
      readDoubleBE(o = 0) { return this._dv.getFloat64(o, false); }
      copy(target, ts = 0, ss = 0, se = this.length) { target.set(this.subarray(ss, se), ts); return se - ss; }
      equals(other) { return this.length === other.length && this.every((b, i) => b === other[i]); }
      write(str, o = 0) { const b = enc.encode(str); this.set(b.subarray(0, this.length - o), o); return b.length; }
      slice(a, b) { return new B(this.subarray(a, b)); }
      toJSON() { return { type: "Buffer", data: [...this] }; }
    }
    const callable = function Buffer(v, e) { return typeof v === "number" ? B.alloc(v) : B.from(v, e); };
    for (const k of ["from", "alloc", "allocUnsafe", "concat", "isBuffer", "byteLength"]) {
      callable[k] = k === "allocUnsafe" ? B.alloc.bind(B) : B[k]?.bind(B);
    }
    callable.prototype = B.prototype;
    Object.setPrototypeOf(callable, B);
    return callable;
  }

  const modules = new Map();   // absolute path -> module.exports
  function requireFrom(dir) {
    return function require(spec) {
      const s = String(spec);
      if (core.has(s)) return core.get(s);
      const resolved = resolveModule(s, dir, has, readJson);
      if (!resolved) {
        throw Object.assign(new Error(`Cannot find module '${s}' from '${dir}'`), { code: "MODULE_NOT_FOUND" });
      }
      // THE CACHE HOLDS THE MODULE, NOT A SNAPSHOT OF ITS EXPORTS.
      //
      // A circular require is made to work by the idiom every careful package
      // uses: assign `module.exports = X` BEFORE requiring the module that
      // requires you back. That only helps if the cycle, re-entering, reads
      // `module.exports` as it stands NOW. Caching the exports OBJECT froze it
      // at the empty `{}` the module started with, so the partner module
      // captured nothing — measured 2026-09-12: semver's Range and Comparator
      // require each other exactly this way, and `satisfies("1.2.3","^1.0.0")`
      // answered false, because `new Range(...)` threw inside its own try.
      if (modules.has(resolved)) return modules.get(resolved).exports;
      const source = dec.decode(files.get(resolved));
      const module = { exports: {}, id: resolved, filename: resolved, loaded: false };
      modules.set(resolved, module);
      if (resolved.endsWith(".json")) { module.exports = JSON.parse(source); module.loaded = true; return module.exports; }
      runSource(source, resolved, module);
      module.loaded = true;
      return module.exports;
    };
  }

  // TOP-LEVEL AWAIT IS THE ENTRY MODULE'S ALONE.
  //
  // `new Function` compiles a SCRIPT, and a script cannot await at its top
  // level — so `const cfg = await load()`, which is ordinary in an ESM plugin,
  // was a SyntaxError with nothing useful in it. Wrapping the body in an async
  // IIFE makes it legal, and the export assignments esmToCjs emits still land
  // on the same `module.exports` object; the caller awaits the promise the
  // wrapper returns before reading them.
  //
  // Only the entry module gets this. `require()` is synchronous by definition:
  // a required module that awaited would hand its requirer an object whose
  // exports had not been assigned yet, which is worse than refusing.
  const TOP_LEVEL_AWAIT = /await is only valid|await is only valid in async functions/;
  function runSource(source, filename, module, { topLevelAwait = false } = {}) {
    const dir = dirnameOf(filename);
    // AN ESM FILE IS REWRITTEN, not refused. `new Function` compiles a script,
    // and a script cannot hold `import` — so the source becomes CommonJS first
    // (esmToCjs). Only when it really is ESM: the test skips `import(` and
    // anything inside a string or a comment.
    // A DYNAMIC `import()` IS REWRITTEN EVEN IN A SCRIPT. `import(x)` is legal
    // in a plain script, so `isEsm` deliberately does not treat it as ESM —
    // but left alone it reaches the engine's own module loader, which has no
    // module to load here and rejects into nothing. Measured 2026-09-12: the
    // entry script printed nothing at all.
    // A SHEBANG IS NOT JAVASCRIPT. `#!/usr/bin/env node` on line 1 is a token
    // no engine accepts; Node strips it before compiling and so does this.
    // Commenting it out rather than cutting it keeps line 1 line 1.
    if (source.startsWith("#!")) source = `//${source.slice(2)}`;
    // TYPES COME OFF FIRST. `new Function` compiles JavaScript, and an
    // annotation is a syntax error to it; typescript.js blanks them in place so
    // every line and column in a stack trace still points at the real source.
    if (isTypeScript(filename)) {
      const stripped = stripTypes(source, filename);
      if (!stripped.ok) throw Object.assign(new SyntaxError(stripped.error), { code: "ERR_UNSUPPORTED_TYPESCRIPT" });
      source = stripped.code;
    }
    source = isEsm(source) ? esmToCjs(source, filename) : source.replace(/(^|[^.\w$])import\s*\(/g, "$1__esmDynamicImport(");
    // THE SHADOWED GLOBALS. Naming them as parameters is what puts this
    // script's `fetch` and `process` in front of the isolate's own.
    const body = topLevelAwait ? `return (async () => {\n${source}\n})();` : source;
    const fn = new Function(
      "require", "module", "exports", "__filename", "__dirname",
      "process", "console", "Buffer", "fetch", "setImmediate", "global", "globalThis",
      "__esmDynamicImport",
      `${body}\n//# sourceURL=${filename}`,
    );
    const sandboxGlobal = { console: consoleMod, process: processMod, fetch: guardedFetch, Buffer: core.get("buffer").Buffer, TextEncoder, TextDecoder, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, Math, JSON, Date, Promise };
    const req = requireFrom(dir);
    return fn.call(
      module.exports, req, module, module.exports, filename, dir,
      processMod, consoleMod, core.get("buffer").Buffer, guardedFetch, (f, ...a) => setTimeout(f, 0, ...a), sandboxGlobal, sandboxGlobal,
      // `await import("m")` is a promise of the module namespace, which here
      // is what require answers — resolved, so a top-level `.then` works.
      async (spec) => { const m = req(spec); return m && m.__esModule ? m : { ...m, default: m }; },
    );
  }

  return {
    files, dirs, core, processMod, consoleMod,
    /** Seed the runtime with a file the loader may need. */
    put(path, bytes) { const abs = resolvePath(cwd, path); files.set(abs, typeof bytes === "string" ? enc.encode(bytes) : bytes); dirs.add(dirnameOf(abs)); },
    get output() { return { stdout: out, stderr: err, truncated }; },
    get exitCode() { return exitCode; },
    /**
     * LOAD a module and hand back its exports, rather than running a script
     * for its output. This is what a plugin loader needs: the project's file
     * is a module, not a program.
     */
    async load(source, filename) {
      const module = { exports: {}, id: filename, filename, loaded: false };
      try {
        let ran;
        try { ran = runSource(source, filename, module); }
        catch (e) { if (!(e instanceof SyntaxError && TOP_LEVEL_AWAIT.test(e.message ?? ""))) throw e; ran = runSource(source, filename, module, { topLevelAwait: true }); }
        await ran;
        return { ok: true, exports: module.exports, stdout: out, stderr: err };
      } catch (e) {
        if (e && typeof e === "object" && "__nodeExit" in e) return { ok: false, error: `the module called process.exit(${e.__nodeExit})` };
        return { ok: false, error: `${e?.name ?? "Error"}: ${e?.message ?? String(e)}`, stderr: err };
      }
    },
    /** Run one source text as the entry module. Never throws: it reports. */
    async run(source, filename) {
      const started = now();
      const module = { exports: {}, id: filename, filename, loaded: false };
      try {
        let ran;
        try { ran = runSource(source, filename, module); }
        catch (e) { if (!(e instanceof SyntaxError && TOP_LEVEL_AWAIT.test(e.message ?? ""))) throw e; ran = runSource(source, filename, module, { topLevelAwait: true }); }
        await ran;
      } catch (e) {
        if (e && typeof e === "object" && "__nodeExit" in e) return { stdout: out, stderr: err, exitCode: e.__nodeExit, truncated };
        const name = e?.name ?? "Error";
        const msg = e?.message ?? String(e);
        const stack = typeof e?.stack === "string" ? e.stack.split("\n").slice(1, 6).map((l) => `    ${l.trim()}`).join("\n") : "";
        write("err", `${filename}\n\n${name}: ${msg}\n${stack}\n`);
        return { stdout: out, stderr: err, exitCode: 1, truncated };
      }
      // A script may leave promises in flight. Give the microtask queue a turn
      // so a top-level `await`-shaped script prints before the command returns,
      // bounded so a pending forever-promise cannot hold the shell.
      for (let i = 0; i < 50 && now() - started < timeoutMs; i++) await Promise.resolve();
      return { stdout: out, stderr: err, exitCode: exitCode ?? 0, truncated };
    },
  };
}

/**
 * `node` AS A SHELL COMMAND, over the cell's tree.
 *
 * Usage the model actually types: `node script.js`, `node -e "..."`,
 * `node -p "..."`, `node --version`. Everything the entry script requires is
 * PRELOADED before evaluation — a walk of the tree, capped — because the
 * loader is synchronous and the tree is not.
 */
export function nodeCommand(defineCommand, { fetch: guardedFetch, maxPreloadFiles = 4000, maxPreloadBytes = 24 * 1024 * 1024 } = {}) {
  return defineCommand("node", async (args, ctx) => {
    let evalSource = null, printResult = false, scriptPath = null;
    const scriptArgs = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (scriptPath || evalSource !== null) { scriptArgs.push(a); continue; }
      if (a === "-v" || a === "--version") return { stdout: `${NODE_VERSION}\n`, stderr: "", exitCode: 0 };
      if (a === "-e" || a === "--eval") { evalSource = args[++i] ?? ""; continue; }
      if (a === "-p" || a === "--print") { evalSource = args[++i] ?? ""; printResult = true; continue; }
      if (a === "-h" || a === "--help") {
        return { stdout: "Usage: node [options] [script.js] [arguments]\n\n  -e, --eval <code>     evaluate code\n  -p, --print <code>    evaluate and print the result\n  -v, --version         print the version\n\nThis is the cell's own JavaScript runtime: real JS, the CommonJS loader,\nand fs/path/os/util/events/assert/url/crypto/buffer over this workspace.\nThere are no sockets, no child processes and no native modules — use the\nmachine tool when a task needs a real Linux box.\n", stderr: "", exitCode: 0 };
      }
      if (a.startsWith("-")) continue;                 // an option this runtime does not have
      scriptPath = a;
    }
    if (evalSource === null && !scriptPath) {
      return { stdout: "", stderr: "node: no script and no -e. `node --help` lists what this runtime has.\n", exitCode: 1 };
    }

    const cwd = ctx.cwd || CELL_CWD;
    const rt = createNodeRuntime({ fs: ctx.fs, cwd, argv: scriptPath ? [resolvePath(cwd, scriptPath), ...scriptArgs] : scriptArgs, env: ctx.env ?? {}, fetch: guardedFetch });

    // PRELOAD. Every file under the workspace, so `require` resolves without a
    // promise. Bounded by count and bytes: a checkout with a node_modules is
    // exactly the case this must not fall over on.
    let loadedFiles = 0, loadedBytes = 0;
    const walk = async (dir, depth) => {
      if (depth > 12 || loadedFiles >= maxPreloadFiles || loadedBytes >= maxPreloadBytes) return;
      let entries;
      try { entries = await ctx.fs.readdirWithFileTypes(dir); } catch { return; }
      for (const e of entries) {
        if (loadedFiles >= maxPreloadFiles || loadedBytes >= maxPreloadBytes) return;
        const abs = `${dir}/${e.name}`.replace(/\/+/g, "/");
        if (e.isDirectory) { if (e.name === ".git") continue; rt.dirs.add(abs); await walk(abs, depth + 1); continue; }
        if (!e.isFile) continue;
        if (!/\.(js|cjs|mjs|json)$/.test(e.name)) continue;
        try {
          const bytes = await ctx.fs.readFileBuffer(abs);
          rt.put(abs, bytes);
          loadedFiles++; loadedBytes += bytes.length;
        } catch { /* a file that cannot be read is a file the script cannot require */ }
      }
    };
    await walk(cwd, 0);

    const source = evalSource !== null
      ? (printResult ? `console.log((${evalSource}))` : evalSource)
      : (() => { const abs = resolvePath(cwd, scriptPath); return rt.files.has(abs) ? new TextDecoder().decode(rt.files.get(abs)) : null; })();
    if (source === null) {
      return { stdout: "", stderr: `node: cannot find module '${scriptPath}'\n`, exitCode: 1 };
    }
    const filename = evalSource !== null ? "[eval]" : resolvePath(cwd, scriptPath);
    const r = await rt.run(source, filename);

    // WHAT THE SCRIPT WROTE GOES BACK TO THE TREE. A script that writes a file
    // and prints nothing did work the next command has to be able to see.
    for (const [abs, bytes] of rt.files) {
      if (!abs.startsWith(`${cwd}/`) && abs !== cwd) continue;
      try {
        const existing = await ctx.fs.readFileBuffer(abs).catch(() => null);
        if (existing && existing.length === bytes.length && existing.every((b, i) => b === bytes[i])) continue;
        await ctx.fs.mkdir(dirnameOf(abs), { recursive: true }).catch(() => {});
        await ctx.fs.writeFile(abs, bytes);
      } catch { /* a write the tree refuses is reported by the next read, not here */ }
    }
    return {
      stdout: r.stdout + (r.truncated ? "\n[output truncated]\n" : ""),
      stderr: r.stderr,
      exitCode: r.exitCode,
    };
  });
}

// ── ESM, WITHOUT A BUNDLER ──────────────────────────────────────────────────
//
// `new Function` compiles a SCRIPT, and `import`/`export` are only legal in a
// module. The engine here has no module loader to hand a source text to, so an
// ESM file is rewritten to CommonJS before it is compiled. Measured need, not
// a guess: of seventeen real packages loaded through this runtime, the only
// one that failed on syntax was the one shipping true ESM
// ("Cannot use import statement outside a module", 2026-09-12).
//
// The rewrite is TEXTUAL, and it is careful about exactly one thing that makes
// textual rewrites wrong: it never edits inside a string, a template, a
// comment or a regex. `maskSource` marks those regions and every pattern below
// is applied only outside them.
//
// WHAT IT DOES NOT DO, said plainly rather than discovered later: live
// bindings (a re-assigned export is read at its old value by an importer),
// top-level await, and circular ESM graphs resolve like CommonJS rather than
// like ESM. Those are the edges; the middle — a package that imports some
// things, exports some things and runs — works.

/** A byte mask of the regions a rewrite must not touch. */
export function maskSource(src) {
  const mask = new Uint8Array(src.length);
  let i = 0;
  // `prev` is the last significant character, which is how a `/` is told from
  // a division: after a value it divides, after an operator it opens a regex.
  let prev = "";
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === "/" && n === "/") { const e = src.indexOf("\n", i); const end = e < 0 ? src.length : e; mask.fill(1, i, end); i = end; continue; }
    if (c === "/" && n === "*") { const e = src.indexOf("*/", i + 2); const end = e < 0 ? src.length : e + 2; mask.fill(1, i, end); i = end; continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === c) { j++; break; }
        // A template's ${...} holds real code; leave it unmasked so a nested
        // string inside it is masked on its own terms.
        if (c === "`" && src[j] === "$" && src[j + 1] === "{") {
          mask.fill(1, i, j);
          let depth = 1; j += 2;
          const inner = j;
          while (j < src.length && depth > 0) { if (src[j] === "{") depth++; else if (src[j] === "}") depth--; j++; }
          void inner;
          i = j; // continue scanning inside the template after the hole
          // Re-enter the template: treat the rest as a fresh template start.
          let k = i;
          while (k < src.length && src[k] !== "`") { if (src[k] === "\\") k++; k++; }
          mask.fill(1, i, Math.min(k + 1, src.length));
          i = Math.min(k + 1, src.length);
          break;
        }
        j++;
      }
      if (j > i) { mask.fill(1, i, Math.min(j, src.length)); i = Math.max(j, i + 1); }
      prev = c;
      continue;
    }
    if (c === "/" && /[=(,:[!&|?{};+\-*%~^<>]|^$/.test(prev)) {
      let j = i + 1, closed = false;
      while (j < src.length) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "[") { while (j < src.length && src[j] !== "]") { if (src[j] === "\\") j++; j++; } }
        if (src[j] === "\n") break;
        if (src[j] === "/") { closed = true; j++; break; }
        j++;
      }
      if (closed) { mask.fill(1, i, j); i = j; prev = "/"; continue; }
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return mask;
}

/** Is this source ESM? An `import`/`export` at a statement position, unmasked. */
export function isEsm(src) {
  const mask = maskSource(src);
  const re = /(^|[\n;{}])\s*(import|export)\b/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const at = m.index + m[0].length - m[2].length;
    if (mask[at]) continue;
    // `import(` and `import.meta` are legal in a script; they do not make one.
    const after = src.slice(at + m[2].length).match(/^\s*[.(]/);
    if (m[2] === "import" && after) continue;
    return true;
  }
  return false;
}

/**
 * ESM source → CommonJS source. Deterministic, and every generated binding is
 * prefixed `__esm` so it cannot collide with the module's own names.
 */
// A TRAILING `\s*` WOULD EAT THE NEWLINE THE NEXT STATEMENT NEEDS. Every
// pattern here anchors on `(^|[\n;{}])`, so a rewrite that consumed the line
// break left the statement after it unmatched — measured 2026-09-14 on the
// starter's own plugin, written without semicolons: every OTHER import
// survived into the output and `new Function` refused the lot.
export function esmToCjs(src, filename = "module.mjs") {
  const mask = maskSource(src);
  const edits = [];
  let uid = 0;
  const tmp = () => `__esm${uid++}`;
  const push = (start, end, text) => edits.push({ start, end, text });
  const unmasked = (idx) => !mask[idx];

  // import ... from "m" | import "m"
  const importRe = /(^|[\n;{}])([ \t]*)import\s+(?:([^'"]*?)\s+from\s+)?(['"])([^'"]+)\4[ \t]*;?/g;
  for (let m = importRe.exec(src); m; m = importRe.exec(src)) {
    const at = m.index + m[1].length + m[2].length;
    if (!unmasked(at)) continue;
    const clause = (m[3] ?? "").trim();
    const spec = m[5];
    const req = `require(${JSON.stringify(spec)})`;
    if (!clause) { push(at, m.index + m[0].length, `${req};`); continue; }
    const v = tmp();
    const parts = [`const ${v} = ${req};`];
    const nsOnly = clause.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
    if (nsOnly) { push(at, m.index + m[0].length, `const ${nsOnly[1]} = ${req};`); continue; }
    // default, then a namespace or a named list
    const braceAt = clause.indexOf("{");
    const head = (braceAt >= 0 ? clause.slice(0, braceAt) : clause).replace(/,\s*$/, "").trim();
    if (head && !head.startsWith("*")) parts.push(`const ${head} = ${v} && ${v}.__esModule ? ${v}.default : ${v};`);
    const star = head.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
    if (star) parts.push(`const ${star[1]} = ${v};`);
    if (braceAt >= 0) {
      const names = clause.slice(braceAt + 1, clause.lastIndexOf("}")).split(",").map((x) => x.trim()).filter(Boolean);
      for (const n of names) {
        const [from, to] = n.split(/\s+as\s+/).map((x) => x.trim());
        parts.push(`const ${to ?? from} = ${v}.${from};`);
      }
    }
    push(at, m.index + m[0].length, parts.join(" "));
  }

  // `import.meta` HAS NO MEANING IN A SCRIPT, and a module that reads
  // `import.meta.url` — to find its own directory, which a plugin does — got a
  // hard SyntaxError instead. The values are known here: this is the file.
  const metaRe = /\bimport\s*\.\s*meta\b(\s*\.\s*(url|dirname|filename|resolve))?/g;
  for (let m = metaRe.exec(src); m; m = metaRe.exec(src)) {
    if (!unmasked(m.index)) continue;
    const dir = filename.slice(0, Math.max(0, filename.lastIndexOf("/"))) || "/";
    const text = m[2] === "url" ? JSON.stringify(`file://${filename}`)
      : m[2] === "dirname" ? JSON.stringify(dir)
      : m[2] === "filename" ? JSON.stringify(filename)
      : m[2] === "resolve" ? `((s) => new URL(s, ${JSON.stringify(`file://${filename}`)}).href)`
      : `({ url: ${JSON.stringify(`file://${filename}`)}, dirname: ${JSON.stringify(dir)}, filename: ${JSON.stringify(filename)} })`;
    push(m.index, m.index + m[0].length, text);
  }

  // export * from "m"  |  export * as ns from "m"
  const starRe = /(^|[\n;{}])([ \t]*)export\s+\*\s*(?:as\s+([A-Za-z_$][\w$]*)\s*)?from\s*(['"])([^'"]+)\4[ \t]*;?/g;
  for (let m = starRe.exec(src); m; m = starRe.exec(src)) {
    const at = m.index + m[1].length + m[2].length;
    if (!unmasked(at)) continue;
    const v = tmp();
    const req = `const ${v} = require(${JSON.stringify(m[5])});`;
    push(at, m.index + m[0].length, m[3]
      ? `${req} exports.${m[3]} = ${v};`
      : `${req} for (const __k of Object.keys(${v})) if (__k !== "default") exports[__k] = ${v}[__k];`);
  }

  // export { a, b as c } [from "m"]
  const namedRe = /(^|[\n;{}])([ \t]*)export\s*\{([^}]*)\}\s*(?:from\s*(['"])([^'"]+)\4)?[ \t]*;?/g;
  for (let m = namedRe.exec(src); m; m = namedRe.exec(src)) {
    const at = m.index + m[1].length + m[2].length;
    if (!unmasked(at)) continue;
    const names = m[3].split(",").map((x) => x.trim()).filter(Boolean);
    const parts = [];
    let src2 = null;
    if (m[5]) { src2 = tmp(); parts.push(`const ${src2} = require(${JSON.stringify(m[5])});`); }
    for (const n of names) {
      const [from, to] = n.split(/\s+as\s+/).map((x) => x.trim());
      const value = src2 ? `${src2}.${from}` : from;
      parts.push(`exports[${JSON.stringify(to ?? from)}] = ${value};`);
    }
    push(at, m.index + m[0].length, parts.join(" "));
  }

  // export default X
  const defRe = /(^|[\n;{}])([ \t]*)export\s+default\s+/g;
  for (let m = defRe.exec(src); m; m = defRe.exec(src)) {
    const at = m.index + m[1].length + m[2].length;
    if (!unmasked(at)) continue;
    const rest = src.slice(m.index + m[0].length);
    const named = rest.match(/^(async\s+function|function|class)\s+([A-Za-z_$][\w$]*)/);
    if (named) push(at, m.index + m[0].length, "");                       // keep the declaration
    else push(at, m.index + m[0].length, "exports.default = ");
    if (named) edits.push({ start: -1, end: -1, append: `\nexports.default = ${named[2]};` });
  }

  // export <decl>
  const declRe = /(^|[\n;{}])([ \t]*)export\s+(const|let|var|function|async\s+function|class)\s+([A-Za-z_$][\w$]*)/g;
  for (let m = declRe.exec(src); m; m = declRe.exec(src)) {
    const at = m.index + m[1].length + m[2].length;
    if (!unmasked(at)) continue;
    push(at, at + "export ".length, "");
    edits.push({ start: -1, end: -1, append: `\nexports.${m[4]} = ${m[4]};` });
  }

  const appends = edits.filter((e) => e.start === -1).map((e) => e.append);
  const replacements = edits.filter((e) => e.start >= 0).sort((a, b) => a.start - b.start);
  let out = "", cursor = 0;
  for (const e of replacements) {
    if (e.start < cursor) continue;      // an overlap: the outer edit wins
    out += src.slice(cursor, e.start) + e.text;
    cursor = e.end;
  }
  out += src.slice(cursor);
  // `import.meta.url` is the one meta a module actually reads.
  out = out.split("import.meta.url").join(JSON.stringify(`file://${filename}`));
  out = out.split("import.meta.dirname").join(JSON.stringify(filename.slice(0, filename.lastIndexOf("/"))));
  // A dynamic `import()` is a promise of the module — require, wrapped.
  out = out.replace(/\bimport\s*\(/g, "__esmDynamicImport(");
  return `${out}\n${appends.join("")}\nexports.__esModule = true;\n`;
}
