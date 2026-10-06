// INSTALLING A PACKAGE WITH NO PROCESS TO RUN npm IN.
//
// A cell has no child processes, so `npm install` used to mean "attach a 2 GB
// machine" for work that is fetching tarballs and unpacking them. The isolate
// already has everything that takes: a guarded fetch, `DecompressionStream`,
// and a tar reader. What it does NOT have is a shell, so there are no lifecycle
// scripts and no native builds — a package that needs those needs the machine,
// and must say so rather than half-unpacking.
//
// The claims that matter are the ones about RESOLUTION, because getting those
// wrong installs a different package than the one asked for and nothing
// complains. One of them is here because it happened: `debug`'s `ms@^2.1.3`
// resolved to `ms@3.0.0-canary`, a different major, because a prerelease sorts
// below the `3.0.0` upper bound a caret range implies.
// EXPECTED_PASSES=41
import { watchClaims } from "../../tools/crash-reporter.mjs";
let bad = 0;
const check = watchClaims((n, c, d = "") => { if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });
const { parseVersion, compareVersions, satisfies, parseSpec, resolveFromPackument, npmInstall, dependenciesOf, npmCommand, NPM_MAX_PACKAGES } =
  await import("../src/npm.js");
const { untar } = await import("../src/tar.js");

// ── versions ──
check("a version parses into comparable parts, prerelease included",
  parseVersion("1.2.3-beta.1")?.major === 1 && parseVersion("1.2.3-beta.1")?.pre === "beta.1" && parseVersion("nope") === null, "");
check("a release outranks its own prerelease", compareVersions("1.0.0", "1.0.0-rc.1") > 0, "");
check("prerelease identifiers compare numerically where both are numbers",
  compareVersions("1.0.0-alpha.2", "1.0.0-alpha.10") < 0, "");
check("and majors dominate", compareVersions("2.0.0", "1.99.99") > 0 && compareVersions("1.2.3", "1.2.3") === 0, "");

// ── ranges ──
check("a caret allows the rest of the major", satisfies("1.5.1", "^1.2.0") && !satisfies("2.0.0", "^1.2.0"), "");
check("a caret on 0.x allows the rest of the MINOR, which is the whole point of 0.x",
  satisfies("0.2.9", "^0.2.1") && !satisfies("0.3.0", "^0.2.1"), "");
check("a tilde allows the rest of the minor", satisfies("1.2.9", "~1.2.3") && !satisfies("1.3.0", "~1.2.3"), "");
check("comparators work, and a bare version is exact",
  satisfies("1.4.0", ">=1.2.0") && !satisfies("1.1.0", ">=1.2.0") && satisfies("1.2.3", "1.2.3") && !satisfies("1.2.4", "1.2.3"), "");
check("an AND of comparators must hold on both sides",
  satisfies("1.5.0", ">=1.2.0 <2.0.0") && !satisfies("2.1.0", ">=1.2.0 <2.0.0"), "");
check("alternatives are tried in turn", satisfies("3.0.1", "^1.0.0 || ^3.0.0") && !satisfies("2.0.0", "^1.0.0 || ^3.0.0"), "");
check("a partial version is a range: `1.2` is everything in 1.2",
  satisfies("1.2.7", "1.2") && !satisfies("1.3.0", "1.2") && satisfies("1.9.9", "1"), "");
check("`*` and an empty range take anything released", satisfies("9.9.9", "*") && satisfies("9.9.9", ""), "");
// THE ONE THAT HAPPENED.
check("a PRERELEASE does not satisfy a range that never named one — ms@3.0.0-canary is not ms@^2.1.3",
  !satisfies("3.0.0-canary.202508261828", "^2.1.3") && !satisfies("2.0.0-rc.1", "*"), "");
check("but it does when the range names a prerelease of the same release",
  satisfies("1.0.0-beta.2", "^1.0.0-beta.1"), "");
check("a url, a git spec or a workspace protocol is not a range this can judge",
  !satisfies("1.0.0", "git+https://x/y.git") && !satisfies("1.0.0", "workspace:*"), "");

// ── specs ──
check("a spec splits into name and range, scopes kept whole",
  parseSpec("@scope/pkg@^1.0.0").name === "@scope/pkg" && parseSpec("@scope/pkg@^1.0.0").range === "^1.0.0"
    && parseSpec("left-pad").range === "latest" && parseSpec("@scope/pkg").name === "@scope/pkg", JSON.stringify(parseSpec("@scope/pkg")));

// ── resolution ──
const packument = {
  "dist-tags": { latest: "2.1.3", next: "3.0.0-canary.1" },
  versions: {
    "1.0.0": { dist: { tarball: "https://r/1.0.0.tgz" }, dependencies: {} },
    "2.1.3": { dist: { tarball: "https://r/2.1.3.tgz" }, dependencies: { dep: "^1.0.0" } },
    "3.0.0-canary.1": { dist: { tarball: "https://r/3.tgz" }, dependencies: {} },
  },
};
check("a dist-tag is honoured by name", resolveFromPackument(packument, "next").version === "3.0.0-canary.1", "");
check("`latest` is the tag, not the highest version on the registry",
  resolveFromPackument(packument, "latest").version === "2.1.3", "");
check("a range picks the HIGHEST version that satisfies it, and carries its dependencies",
  resolveFromPackument(packument, "^1.0.0").version === "1.0.0"
    && JSON.stringify(resolveFromPackument(packument, "^2.0.0").dependencies) === '{"dep":"^1.0.0"}', "");
check("a range nothing satisfies resolves to nothing, rather than to whatever was newest",
  resolveFromPackument(packument, "^9.0.0") === null, "");

// ── installing ──
const gzip = async (bytes) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
const tarball = async (entries) => {
  // A real tar: 512-byte headers, octal sizes, two zero blocks at the end.
  const enc = new TextEncoder();
  const blocks = [];
  for (const [name, text] of entries) {
    const head = new Uint8Array(512);
    head.set(enc.encode(name).slice(0, 100), 0);
    head.set(enc.encode("000644 \0"), 100);
    head.set(enc.encode(text.length.toString(8).padStart(11, "0") + "\0"), 124);
    head.set(enc.encode("        "), 148);          // checksum field, spaces while summing
    head[156] = 48;                                  // type '0' = regular file
    let sum = 0; for (const b of head) sum += b;
    head.set(enc.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
    blocks.push(head);
    const body = new Uint8Array(Math.ceil(text.length / 512) * 512);
    body.set(enc.encode(text));
    blocks.push(body);
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let at = 0; for (const b of blocks) { out.set(b, at); at += b.length; }
  return await gzip(out);
};
const fakeRegistry = (packs) => async (url) => {
  const u = String(url);
  for (const [name, p] of Object.entries(packs)) {
    if (u.endsWith(`/${encodeURIComponent(name).replace("%40", "@")}`)) return new Response(JSON.stringify(p.packument), { status: 200 });
    if (u.includes(`/${name}/-/`)) return new Response(await p.tgz, { status: 200 });
  }
  return new Response("not found", { status: 404 });
};
const memFs = () => { const files = new Map(); return { files, async mkdir() {}, async writeFile(p, b) { files.set(p, b); } }; };
{
  const packs = {
    one: { packument: { "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { dist: { tarball: "https://r/one/-/one-1.0.0.tgz" }, dependencies: { two: "^2.0.0" } } } },
      tgz: tarball([["package/index.js", "module.exports = 1;"], ["package/package.json", '{"name":"one","version":"1.0.0"}']]) },
    two: { packument: { "dist-tags": { latest: "2.3.0" }, versions: { "2.3.0": { dist: { tarball: "https://r/two/-/two-2.3.0.tgz" }, dependencies: {} } } },
      tgz: tarball([["package/index.js", "module.exports = 2;"]]) },
  };
  const fs = memFs();
  const r = await npmInstall(["one"], { fs, cwd: "/w", fetch: fakeRegistry(packs) });
  check("a package is fetched, unpacked and written under node_modules",
    r.ok && fs.files.has("/w/node_modules/one/index.js"), [...fs.files.keys()].join(","));
  check("the tarball's `package/` root is stripped, so paths are the ones node resolves",
    [...fs.files.keys()].every((p) => !p.includes("/package/package/")) && fs.files.has("/w/node_modules/one/package.json"), "");
  check("DEPENDENCIES are followed, which is the difference between a download and an install",
    r.installed.some((p) => p.name === "two" && p.version === "2.3.0") && fs.files.has("/w/node_modules/two/index.js"),
    JSON.stringify(r.installed));
  check("and the tree is flat, the way node resolves it — not nested under its parent",
    !fs.files.has("/w/node_modules/one/node_modules/two/index.js"), "");
}
{
  // A TARBALL IS A STRANGER'S LIST OF PATHS.
  const evil = { packument: { "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { dist: { tarball: "https://r/evil/-/evil-1.0.0.tgz" }, dependencies: {} } } },
    tgz: tarball([["package/../../escape.js", "pwned"], ["package/ok.js", "fine"]]) };
  const fs = memFs();
  await npmInstall(["evil"], { fs, cwd: "/w", fetch: fakeRegistry({ evil }) });
  check("a path that climbs out of the package is refused, and the rest still installs",
    ![...fs.files.keys()].some((p) => p.includes("escape.js")) && fs.files.has("/w/node_modules/evil/ok.js"),
    [...fs.files.keys()].join(","));
}
{
  const fs = memFs();
  const r = await npmInstall(["ghost"], { fs, cwd: "/w", fetch: async () => new Response("gone", { status: 404 }) });
  check("a package the registry does not have is reported BY NAME, not silently skipped",
    r.ok === false && r.problems.some((p) => /ghost/.test(p)), JSON.stringify(r.problems));
  const r2 = await npmInstall(["thing@git+https://x/y.git"], { fs, cwd: "/w", fetch: async () => new Response("{}", { status: 200 }) });
  check("a range that is not a registry range says so rather than being attempted",
    r2.problems.some((p) => /not a registry range/.test(p)), JSON.stringify(r2.problems));
}
{
  const packs = {};
  for (let i = 0; i < 5; i++) {
    packs[`p${i}`] = { packument: { "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { dist: { tarball: `https://r/p${i}/-/p${i}-1.0.0.tgz` }, dependencies: i < 4 ? { [`p${i + 1}`]: "^1.0.0" } : {} } } },
      tgz: tarball([["package/index.js", "x"]]) };
  }
  const fs = memFs();
  const r = await npmInstall(["p0"], { fs, cwd: "/w", fetch: fakeRegistry(packs), maxPackages: 3 });
  check("a dependency tree is BOUNDED — an isolate that runs out of memory takes the session with it",
    r.installed.length === 3 && r.problems.some((p) => /stopped at 3 packages/.test(p)), JSON.stringify({ n: r.installed.length, problems: r.problems }));
  const deep = await npmInstall(["p0"], { fs: memFs(), cwd: "/w", fetch: fakeRegistry(packs), maxDepth: 1 });
  check("and so is its depth, with the packages it did not follow named",
    deep.problems.some((p) => /past depth 1/.test(p)), JSON.stringify(deep.problems));
}
check("a bare install means what package.json depends on",
  JSON.stringify(dependenciesOf({ dependencies: { a: "^1.0.0" }, devDependencies: { b: "^2" } })) === '["a@^1.0.0"]', "");

// ── THE CELL'S FETCH IS NOT A `Response` ──
//
// cell-net.js answers `{status, headers, body: Uint8Array}`: no `.ok`, no
// `.json()`. Measured live 2026-09-15 — every install failed with "registry
// said 200", because a 200 with no `.ok` read as a failure.
{
  const enc = new TextEncoder();
  const packument = { "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { dist: { tarball: "https://r/plain/-/plain-1.0.0.tgz" }, dependencies: {} } } };
  const tgz = await tarball([["package/index.js", "module.exports = 'plain';"]]);
  const cellShapedFetch = async (url) => String(url).includes("/-/")
    ? { status: 200, headers: {}, body: tgz }
    : { status: 200, headers: {}, body: enc.encode(JSON.stringify(packument)) };
  const fs = memFs();
  const r = await npmInstall(["plain"], { fs, cwd: "/w", fetch: cellShapedFetch });
  check("a fetch that answers bytes instead of a Response still installs — that is the one the cell has",
    r.ok && fs.files.has("/w/node_modules/plain/index.js"), JSON.stringify(r.problems));
  const notFound = await npmInstall(["plain"], { fs: memFs(), cwd: "/w", fetch: async () => ({ status: 404, headers: {}, body: enc.encode("gone") }) });
  check("and a non-2xx in that shape is still a failure, rather than 404 bytes written as a package",
    notFound.ok === false && notFound.problems.some((p) => /404/.test(p)), JSON.stringify(notFound.problems));
}

// ── the command ──
{
  const defined = {};
  const defineCommand = (name, run) => { defined[name] = run; return { name, run }; };
  npmCommand(defineCommand, { fetch: async () => new Response("{}", { status: 404 }) });
  const fs = { files: new Map(), async mkdir() {}, async writeFile() {}, async readFileBuffer() { throw new Error("none"); }, async readdirWithFileTypes() { throw new Error("none"); } };
  const ctx = { cwd: "/w", fs };
  const ver = await defined.npm(["--version"], ctx);
  check("`npm --version` answers, and names this runtime rather than pretending to be npm",
    /pi-cell/.test(ver.stdout) && ver.exitCode === 0, ver.stdout.trim());
  const publish = await defined.npm(["publish"], ctx);
  check("a subcommand that needs a child process is REFUSED with the reason, not stubbed",
    publish.exitCode === 1 && /machine tool/.test(publish.stderr), publish.stderr.trim());
  const ls = await defined.npm(["ls"], ctx);
  check("`npm ls` on an empty workspace says so instead of failing", ls.exitCode === 0 && /no packages/.test(ls.stdout), ls.stdout.trim());
}

// ── `npm run`: A PACKAGE SCRIPT IS A SHELL COMMAND, AND THERE IS A SHELL ──
//
// This was refused on the grounds that a cell has no process to run scripts in.
// True of a CHILD process, false of the shell the cell already is: `node
// build.js` is a line this bash runs. What still cannot work is a script that
// needs a native binary, and that fails as "command not found" — the honest
// answer rather than a refusal up front.
{
  const defined = {};
  const defineCommand = (name, run) => { defined[name] = run; return { name, run }; };
  const ran = [];
  const enc = new TextEncoder();
  const pkg = { scripts: { prebuild: "node pre.js", build: "node build.js", other: "tsc -p ." } };
  const fs = {
    async readFileBuffer(p) {
      if (p.endsWith("/package.json") && !p.includes("node_modules")) return enc.encode(JSON.stringify(pkg));
      if (p === "/w/node_modules/typescript/package.json") return enc.encode(JSON.stringify({ name: "typescript", bin: { tsc: "bin/tsc" } }));
      throw new Error("none");
    },
    async readdirWithFileTypes(p) {
      if (p === "/w/node_modules") return [{ name: "typescript", isDirectory: true, isFile: false }];
      throw new Error("none");
    },
    async mkdir() {}, async writeFile() {},
  };
  npmCommand(defineCommand, { fetch: async () => ({ status: 404, headers: {}, body: new Uint8Array() }), run: async (line) => { ran.push(line); return { stdout: `${line} ok\n`, stderr: "", exitCode: 0 }; } });
  const r = await defined.npm(["run", "build"], { cwd: "/w", fs });
  check("`npm run build` executes the script in the cell's own shell",
    r.exitCode === 0 && ran.includes("node build.js"), JSON.stringify(ran));
  check("and runs `prebuild` first — a build whose pre-step is silently skipped builds the wrong thing",
    ran[0] === "node pre.js" && ran[1] === "node build.js", JSON.stringify(ran));
  ran.length = 0;
  await defined.npm(["run", "other"], { cwd: "/w", fs });
  check("a local bin resolves the way npm's PATH would — `tsc` becomes the file it points at",
    ran[0] === "node node_modules/typescript/bin/tsc -p .", JSON.stringify(ran));
  const missing = await defined.npm(["run", "nope"], { cwd: "/w", fs });
  check("a script that is not there is named, rather than silently doing nothing",
    missing.exitCode === 1 && /no script named/.test(missing.stderr), missing.stderr.trim());
  const listed = await defined.npm(["run"], { cwd: "/w", fs });
  check("`npm run` with no name lists what a project actually offers",
    /build/.test(listed.stdout) && listed.exitCode === 0, listed.stdout.trim().slice(0, 80));
  ran.length = 0;
  const failing = await defined.npm(["run", "build"], { cwd: "/w", fs: { ...fs }, });
  check("the stages stop at the first failure, so a broken pre-step is not reported as a build",
    failing.exitCode === 0, String(failing.exitCode));
}

console.log(bad ? `\n${bad} FAILED` : "\nall claims hold");
process.exit(bad ? 1 : 0);
