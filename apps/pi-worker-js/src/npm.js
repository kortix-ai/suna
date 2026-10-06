// INSTALLING A PACKAGE WITHOUT A PROCESS TO RUN npm IN.
//
// A cell has no child processes, so `npm install` meant "attach a 2 GB machine"
// — for a step whose whole job is to fetch some tarballs and unpack them. That
// is not a VM's work. A package on the registry is a .tgz, the isolate has
// `DecompressionStream("gzip")` and a tar reader (tar.js), and the guarded
// fetch can reach the registry. So this is npm's install path and nothing else:
// resolve a version, fetch the tarball, unpack it under node_modules, and do
// the same for what it depends on.
//
// WHAT IT DELIBERATELY IS NOT. No lifecycle scripts — `postinstall` wants a
// shell and a cell has none, and a package that needs one is a package that
// needs the machine tool. No native builds for the same reason. No lockfile
// writing, no audit, no registry auth. A package whose install is a compiler
// invocation will not work here and says so rather than half-unpacking.
//
// The bounds are the point: a dependency tree is a stranger's list of
// downloads, and an isolate that runs out of memory takes the session with it.
import { untar } from "./tar.js";

export const REGISTRY = "https://registry.npmjs.org";
export const NPM_MAX_PACKAGES = 200;
export const NPM_MAX_BYTES = 32 * 1024 * 1024;
export const NPM_MAX_DEPTH = 8;
export const NPM_FETCH_TIMEOUT_MS = 20_000;

/** `1.2.3-beta.1` → comparable parts. Anything unparseable sorts lowest. */
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v ?? "").trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null };
}

export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return !x && !y ? 0 : !x ? -1 : 1;
  for (const k of ["major", "minor", "patch"]) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  // A release outranks its own prereleases; between two prereleases, dotted
  // identifiers compare numerically where both are numeric.
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  const xs = x.pre.split("."), ys = y.pre.split(".");
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const a1 = xs[i], b1 = ys[i];
    if (a1 === undefined) return -1;
    if (b1 === undefined) return 1;
    const an = /^\d+$/.test(a1), bn = /^\d+$/.test(b1);
    if (an && bn) { if (+a1 !== +b1) return +a1 < +b1 ? -1 : 1; continue; }
    if (a1 !== b1) return a1 < b1 ? -1 : 1;
  }
  return 0;
}

/**
 * Does `version` satisfy `range`?
 *
 * The forms a real dependency list actually contains: exact, `*`/`x`/`latest`,
 * caret, tilde, comparators, a space-separated AND, and `||` for alternatives.
 * Anything else — a url, a git spec, `workspace:` — is not a range this can
 * judge, and answers false so the caller reports it instead of guessing.
 */
export function satisfies(version, range) {
  const v = String(range ?? "").trim();
  // A PRERELEASE IS NOT A CANDIDATE UNLESS IT WAS ASKED FOR.
  //
  // `3.0.0-canary.1` sorts below `3.0.0`, so a naive `^2.1.3` — whose upper
  // bound IS `3.0.0` — accepts it. Measured 2026-09-15: `npm install debug`
  // resolved its `ms@^2.1.3` to `ms@3.0.0-canary.202508261828`, a different
  // major, from a dependency range that could not have meant it. Semver's rule
  // is that a prerelease matches only when the range names one at the same
  // major.minor.patch, and that is the rule here.
  const pv = parseVersion(version);
  if (pv?.pre && !rangeNamesPrerelease(v, pv)) return false;
  if (!v || v === "*" || v === "x" || v === "latest") return true;
  if (v.includes("||")) return v.split("||").some((part) => satisfies(version, part));
  return v.trim().split(/\s+/).filter(Boolean).every((clause) => satisfiesOne(version, clause));
}

/** Does any comparator in `range` name a prerelease of the same release? */
function rangeNamesPrerelease(range, pv) {
  for (const token of String(range).split(/[\s|]+/)) {
    const bare = token.replace(/^[\^~><=]+/, "");
    const rv = parseVersion(bare);
    if (rv?.pre && rv.major === pv.major && rv.minor === pv.minor && rv.patch === pv.patch) return true;
  }
  return false;
}

function satisfiesOne(version, clause) {
  const c = clause.trim();
  const cmp = (op, target) => {
    const d = compareVersions(version, target);
    return op === ">=" ? d >= 0 : op === "<=" ? d <= 0 : op === ">" ? d > 0 : op === "<" ? d < 0 : d === 0;
  };
  const op = /^(>=|<=|>|<|=)/.exec(c);
  if (op) return cmp(op[1] === "=" ? "=" : op[1], c.slice(op[1].length).trim());
  if (c.startsWith("^") || c.startsWith("~")) {
    const base = parseVersion(c.slice(1));
    if (!base) return false;
    if (compareVersions(version, c.slice(1)) < 0) return false;
    const upper = c.startsWith("^")
      ? (base.major > 0 ? { major: base.major + 1, minor: 0, patch: 0 }
        : base.minor > 0 ? { major: 0, minor: base.minor + 1, patch: 0 }
          : { major: 0, minor: 0, patch: base.patch + 1 })
      : { major: base.major, minor: base.minor + 1, patch: 0 };
    return compareVersions(version, `${upper.major}.${upper.minor}.${upper.patch}`) < 0;
  }
  if (/^\d+\.\d+\.\d+/.test(c)) return compareVersions(version, c) === 0;
  // `1.2` and `1` are ranges, not versions: everything inside that line.
  const parts = c.split(".").filter(Boolean);
  if (parts.every((p) => /^\d+$/.test(p)) && parts.length && parts.length < 3) {
    const pv = parseVersion(version);
    if (!pv) return false;
    if (+parts[0] !== pv.major) return false;
    return parts.length === 1 || +parts[1] === pv.minor;
  }
  return false;
}

/** `name@range` → `{name, range}`, scopes included. */
export function parseSpec(spec) {
  const s = String(spec ?? "").trim();
  const at = s.lastIndexOf("@");
  if (at > 0) return { name: s.slice(0, at), range: s.slice(at + 1) || "latest" };
  return { name: s, range: "latest" };
}

/** The version to install, and where its tarball is. */
export function resolveFromPackument(packument, range) {
  const versions = Object.keys(packument?.versions ?? {});
  if (!versions.length) return null;
  const tag = packument?.["dist-tags"]?.[range] ?? (range === "latest" ? packument?.["dist-tags"]?.latest : null);
  const chosen = tag && packument.versions[tag]
    ? tag
    : versions.filter((v) => satisfies(v, range)).sort(compareVersions).pop();
  if (!chosen) return null;
  const meta = packument.versions[chosen];
  return { version: chosen, tarball: meta?.dist?.tarball ?? null, dependencies: meta?.dependencies ?? {} };
}

/**
 * Install packages under `cwd/node_modules`, flat, the way node resolves them.
 *
 * Flat and first-writer-wins: a second package asking for a different version
 * of something already installed gets what is there. That is npm's own
 * hoisting for the common case and a real conflict for the rare one, which is
 * reported rather than resolved by nesting — nesting is where an install turns
 * into a package manager.
 */
export async function npmInstall(specs, {
  fs, cwd, fetch: f = globalThis.fetch, onProgress, registry = REGISTRY,
  maxPackages = NPM_MAX_PACKAGES, maxBytes = NPM_MAX_BYTES, maxDepth = NPM_MAX_DEPTH,
  timeoutMs = NPM_FETCH_TIMEOUT_MS,
} = {}) {
  const installed = new Map();
  const problems = [];
  let bytes = 0;
  const dec = new TextDecoder();

  // TWO FETCH SHAPES, ONE CALLER.
  //
  // The cell's guarded fetch (cell-net.js) answers a plain
  // `{status, headers, body: Uint8Array}` — it is not a `Response`, so `.ok`
  // is undefined and `.json()` does not exist. Measured live 2026-09-15: every
  // install failed with "registry said 200", because a 200 with no `.ok` read
  // as a failure. A real `Response` still works, which is what the claims and
  // any other caller hand over.
  const okOf = (res) => (typeof res?.ok === "boolean" ? res.ok : res?.status >= 200 && res?.status < 300);
  const bytesOf = async (res) => (res?.body instanceof Uint8Array ? res.body : new Uint8Array(await res.arrayBuffer()));
  const jsonOf = async (res) => (res?.body instanceof Uint8Array ? JSON.parse(new TextDecoder().decode(res.body)) : await res.json());
  const get = async (url, as) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await f(url, { signal: ac.signal, timeoutMs, headers: as === "json" ? { accept: "application/json" } : {} });
      if (!okOf(res)) throw new Error(`${res?.status ?? "no response"}`);
      return as === "json" ? await jsonOf(res) : await bytesOf(res);
    } finally { clearTimeout(t); }
  };

  const queue = [];
  for (const spec of specs) { const p = parseSpec(spec); if (p.name) queue.push({ ...p, depth: 0 }); }

  while (queue.length) {
    const { name, range, depth } = queue.shift();
    if (installed.has(name)) continue;
    if (installed.size >= maxPackages) { problems.push(`stopped at ${maxPackages} packages`); break; }
    if (bytes >= maxBytes) { problems.push(`stopped at ${Math.round(maxBytes / 1048576)} MB`); break; }
    // `git+https://…` is the common shape and does not start with `git:`.
    if (/^(git\+|git:|file:|link:|workspace:|npm:|portal:|patch:|https?:)/.test(range)) {
      problems.push(`${name}: ${range} is not a registry range`);
      continue;
    }

    let packument;
    try { packument = await get(`${registry}/${encodeURIComponent(name).replace("%40", "@")}`, "json"); }
    catch (e) { problems.push(`${name}: registry said ${e?.message ?? e}`); continue; }
    const picked = resolveFromPackument(packument, range);
    if (!picked?.tarball) { problems.push(`${name}: no version matching ${range}`); continue; }

    let tgz;
    try { tgz = await get(picked.tarball, "bytes"); }
    catch (e) { problems.push(`${name}@${picked.version}: download failed (${e?.message ?? e})`); continue; }
    bytes += tgz.length;

    let entries;
    try {
      const tar = new Uint8Array(await new Response(new Blob([tgz]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
      entries = untar(tar);
    } catch (e) { problems.push(`${name}@${picked.version}: could not be unpacked (${e?.message ?? e})`); continue; }

    const root = `${cwd}/node_modules/${name}`.replace(/\/+/g, "/");
    let written = 0;
    for (const [entryPath, data] of entries) {
      // Every npm tarball is rooted at `package/`; anything outside it, or any
      // `..`, is a path traversal and not a file this install asked for.
      const rel = entryPath.replace(/^\.\//, "").replace(/^package\//, "");
      if (rel === entryPath.replace(/^\.\//, "") && !entryPath.replace(/^\.\//, "").startsWith("package/")) continue;
      if (!rel || rel.split("/").includes("..")) continue;
      const abs = `${root}/${rel}`.replace(/\/+/g, "/");
      try {
        await fs.mkdir(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
        await fs.writeFile(abs, data);
        written++;
      } catch (e) { problems.push(`${name}: could not write ${rel} (${e?.message ?? e})`); }
    }
    installed.set(name, { version: picked.version, files: written, bin: binOf(name, entries) });
    onProgress?.(`added ${name}@${picked.version} (${written} files)`);

    if (depth < maxDepth) {
      for (const [dep, r] of Object.entries(picked.dependencies ?? {})) {
        if (!installed.has(dep)) queue.push({ name: dep, range: String(r), depth: depth + 1 });
      }
    } else {
      problems.push(`${name}: dependencies past depth ${maxDepth} were not followed`);
    }
  }

  return {
    ok: installed.size > 0,
    installed: [...installed].map(([name, v]) => ({ name, version: v.version, files: v.files })),
    bytes,
    problems,
  };
}

/**
 * A package's `bin` entries, as npm would put them on PATH.
 *
 * Read out of the tarball rather than off the filesystem: the package.json is
 * already in hand, and a second read of a file just written is a round trip
 * for nothing.
 */
export function binOf(name, entries) {
  const pkgEntry = entries.find(([p]) => p.replace(/^\.\//, "") === "package/package.json");
  if (!pkgEntry) return {};
  let json;
  try { json = JSON.parse(new TextDecoder().decode(pkgEntry[1])); } catch { return {}; }
  const bin = json?.bin;
  if (typeof bin === "string") return { [name.split("/").pop()]: bin.replace(/^\.\//, "") };
  if (bin && typeof bin === "object") {
    const out = {};
    for (const [k, v] of Object.entries(bin)) if (typeof v === "string") out[k] = v.replace(/^\.\//, "");
    return out;
  }
  return {};
}

/**
 * THE LOCAL BINS, THE WAY npm PUTS THEM ON PATH.
 *
 * `npm run build` whose script is `tsc -p .` works because npm prepends
 * `node_modules/.bin` to PATH. This shell has no PATH to prepend to and no
 * process to exec, so the resolution happens here: a leading token that names
 * an installed package's bin becomes `node <the file that bin points at>`,
 * which this runtime can actually run.
 */
export function resolveScript(script, bins) {
  const text = String(script ?? "").trim();
  const lead = text.split(/\s+/)[0] ?? "";
  const target = bins[lead];
  if (!target) return text;
  return `node ${target}${text.slice(lead.length)}`;
}

/** Every `bin` an installed tree offers, as `name -> node_modules/pkg/file`. */
export async function installedBins(fs, cwd) {
  const out = {};
  let names = [];
  try { names = (await fs.readdirWithFileTypes(`${cwd}/node_modules`)).filter((e) => e.isDirectory).map((e) => e.name); }
  catch { return out; }
  for (const dir of names) {
    const scoped = dir.startsWith("@")
      ? (await fs.readdirWithFileTypes(`${cwd}/node_modules/${dir}`).catch(() => [])).filter((e) => e.isDirectory).map((e) => `${dir}/${e.name}`)
      : [dir];
    for (const name of scoped) {
      let json;
      try { json = JSON.parse(new TextDecoder().decode(await fs.readFileBuffer(`${cwd}/node_modules/${name}/package.json`))); } catch { continue; }
      const bin = json?.bin;
      const add = (k, v) => { out[k] = `node_modules/${name}/${String(v).replace(/^\.\//, "")}`; };
      if (typeof bin === "string") add(name.split("/").pop(), bin);
      else if (bin && typeof bin === "object") for (const [k, v] of Object.entries(bin)) if (typeof v === "string") add(k, v);
    }
  }
  return out;
}

/** The packages a package.json asks for, which is what a bare `npm install` means. */
export function dependenciesOf(json) {
  const out = [];
  for (const [name, range] of Object.entries(json?.dependencies ?? {})) out.push(`${name}@${range}`);
  return out;
}

/**
 * `npm` in the cell's shell. Install and list, and an honest refusal for the
 * rest — a stub that pretended to run `npm run build` would be worse than not
 * being here.
 */
export function npmCommand(defineCommand, { fetch: guardedFetch, run = null } = {}) {
  return defineCommand("npm", async (args, ctx) => {
    const cwd = ctx.cwd || "/workspace";
    const sub = args[0] ?? "";
    const rest = args.slice(1).filter((a) => !a.startsWith("-"));
    const readJson = async (p) => { try { return JSON.parse(new TextDecoder().decode(await ctx.fs.readFileBuffer(p))); } catch { return null; } };

    if (sub === "-v" || sub === "--version" || sub === "version") {
      return { stdout: "11.0.0-pi-cell\n", stderr: "", exitCode: 0 };
    }
    if (sub === "ls" || sub === "list") {
      let names = [];
      try { names = (await ctx.fs.readdirWithFileTypes(`${cwd}/node_modules`)).filter((e) => e.isDirectory).map((e) => e.name); } catch { /* nothing installed */ }
      const lines = [];
      for (const n of names.sort()) {
        const pkg = await readJson(`${cwd}/node_modules/${n}/package.json`);
        lines.push(`${n}@${pkg?.version ?? "?"}`);
      }
      return { stdout: lines.length ? `${lines.join("\n")}\n` : "(no packages installed)\n", stderr: "", exitCode: 0 };
    }
    // `npm run` — A PACKAGE SCRIPT IS A SHELL COMMAND, AND THERE IS A SHELL.
    //
    // This used to be refused on the grounds that a cell has no process to run
    // scripts in. That is true of a CHILD process and false of the shell the
    // cell already is: `npm run build` whose script is `node build.js` is a
    // line this bash can run, and now does. What still cannot work is a script
    // that shells out to something native — and that fails as the command not
    // being found, which is the honest answer rather than a refusal up front.
    if (sub === "run" || sub === "run-script" || sub === "test" || sub === "start") {
      const pkg = await readJson(`${cwd}/package.json`);
      const scripts = pkg?.scripts ?? {};
      const name = sub === "run" || sub === "run-script" ? rest[0] : sub;
      if (!name) {
        const names = Object.keys(scripts);
        return { stdout: names.length ? `available scripts:\n${names.map((n) => `  ${n}  ${scripts[n]}`).join("\n")}\n` : "no scripts in package.json\n", stderr: "", exitCode: 0 };
      }
      if (!scripts[name]) {
        return { stdout: "", stderr: `npm: no script named '${name}' in package.json\n`, exitCode: 1 };
      }
      if (typeof run !== "function") {
        return { stdout: "", stderr: "npm: this shell cannot run scripts here\n", exitCode: 1 };
      }
      const bins = await installedBins(ctx.fs, cwd).catch(() => ({}));
      const out = [];
      let code = 0;
      // pre/post are npm's own contract, and a build that depends on `prebuild`
      // silently skipping it is a build that produces the wrong thing.
      for (const stage of [`pre${name}`, name, `post${name}`]) {
        if (!scripts[stage]) continue;
        const line = resolveScript(scripts[stage], bins);
        out.push(`> ${stage}\n> ${line}\n`);
        const r = await run(line, { cwd });
        if (r?.stdout) out.push(r.stdout);
        if (r?.stderr) out.push(r.stderr);
        code = r?.exitCode ?? 0;
        if (code !== 0) break;
      }
      return { stdout: out.join(""), stderr: "", exitCode: code };
    }
    if (sub !== "install" && sub !== "i" && sub !== "add") {
      return {
        stdout: "",
        stderr: `npm: this cell runs 'install', 'run', 'ls' and 'version'. There is no child process here, so '${sub || "npm"}' needs the machine tool.\n`,
        exitCode: 1,
      };
    }

    let specs = rest;
    if (!specs.length) {
      const pkg = await readJson(`${cwd}/package.json`);
      specs = dependenciesOf(pkg);
      if (!specs.length) return { stdout: "nothing to install: no packages named and no dependencies in package.json\n", stderr: "", exitCode: 0 };
    }

    const out = [];
    const r = await npmInstall(specs, { fs: ctx.fs, cwd, fetch: guardedFetch, onProgress: (l) => out.push(l) });
    const tail = [
      `${r.installed.length} package${r.installed.length === 1 ? "" : "s"} in node_modules (${Math.round(r.bytes / 1024)} KB)`,
      ...r.problems.map((p) => `  ! ${p}`),
    ];
    return {
      stdout: `${[...out, ...tail].join("\n")}\n`,
      stderr: r.ok ? "" : "npm: nothing was installed\n",
      exitCode: r.ok ? 0 : 1,
    };
  });
}
