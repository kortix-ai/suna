// `git` IN THE CELL'S SHELL.
//
// A session's checkout is a real git repository (cell-git.js clones it with
// isomorphic-git), but the shell had no `git`: an agent that ran `git status`
// or `git diff` before committing got "command not found" and either gave up
// or worked around it. kortixd's pi runs on a box with git, so the parity gap
// was the most common command an agent reaches for.
//
// This is the local subset an agent uses, over isomorphic-git and the cell's
// own tree: status, diff, log, show, add, rm, commit, restore, reset,
// checkout/switch, branch, rev-parse, ls-files, config, remote, init.
// Network git is not here on purpose: Kortix pushes the session's branch
// itself (`POST /kortix/git/commit-push`), with a token the shell never sees.
// Anything outside the subset fails loudly, naming what exists.
//
// STATUS IS COMPUTED FROM OBJECT IDS, NEVER FROM THE INDEX'S STAT CACHE. The
// tree writes whole files in milliseconds, so two writes inside one second
// are indistinguishable at git's stat granularity (cell-git.js
// `workingStatus` has the measurement). Every tracked file's content is
// hashed and compared with the index entry, which a clock cannot fool.
import { structuredPatch } from "diff";
import ignore from "ignore";
import { git, gitFs, toBytes } from "./cell-git.js";

/** The subcommands this git has, as the error for any other one lists them. */
export const GIT_SUBCOMMANDS = [
  "add", "branch", "checkout", "commit", "config", "diff", "init", "log", "ls-files",
  "remote", "reset", "restore", "rev-parse", "rm", "show", "status", "switch", "version",
];
const NETWORK = new Set(["push", "pull", "fetch", "clone", "ls-remote", "submodule"]);
const DEFAULT_AUTHOR = { name: "Kortix", email: "agent@kortix.ai" };
const ZERO = "0000000000000000000000000000000000000000";

const result = (stdout = "", stderr = "", exitCode = 0) => ({ stdout, stderr, exitCode });

/** A git-shaped failure: thrown anywhere, answered as `{stdout, stderr, exitCode}`. */
class GitExit extends Error {
  constructor(stderr, exitCode = 128, stdout = "") {
    super(stderr);
    this.result = result(stdout, stderr.endsWith("\n") || !stderr ? stderr : `${stderr}\n`, exitCode);
  }
}
const fatal = (msg) => new GitExit(`fatal: ${msg}`, 128);
const usageError = (msg) => new GitExit(`error: ${msg}`, 129);
const unsupported = (what) =>
  new GitExit(`git: ${what} is not supported in this cell. Supported: ${GIT_SUBCOMMANDS.join(", ")}.`, 1);

// ── paths ────────────────────────────────────────────────────────────────

/** POSIX normalisation of an absolute path. */
function normalize(path) {
  const out = [];
  for (const seg of String(path).split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}
const absolute = (cwd, p) => normalize(String(p).startsWith("/") ? p : `${cwd}/${p}`);
/** `to` relative to `from`, both absolute. */
function relative(from, to) {
  const a = normalize(from).split("/").filter(Boolean);
  const b = normalize(to).split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}
const joinRel = (dir, name) => (dir ? `${dir}/${name}` : name);
/** `path` is `spec` or under it; the empty spec is the whole repository. */
const under = (path, spec) => spec === "" || path === spec || path.startsWith(`${spec}/`);
const matchesAny = (path, specs) => specs.length === 0 || specs.some((s) => under(path, s));

const modeString = (mode) => (Number(mode) || 0o100644).toString(8).padStart(6, "0");
const short = (oid) => String(oid ?? "").slice(0, 7);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const decoder = new TextDecoder();

// ── the repository ───────────────────────────────────────────────────────

/** The repository the working directory is in, or a git-shaped fatal. */
async function openRepo(raw, cwd, env, overrides) {
  const fs = gitFs(raw);
  const root = await git.findRoot({ fs, filepath: cwd }).catch(() => null);
  if (!root) throw fatal("not a git repository (or any of the parent directories): .git");
  const repo = { raw, fs, dir: root, cwd, env, overrides, cache: {} };
  repo.prefix = relative(root, cwd);
  /** A pathspec as the user typed it, made repository-relative ("" is the root). */
  repo.spec = (p) => {
    const rel = relative(root, absolute(cwd, p));
    if (rel === ".." || rel.startsWith("../")) throw fatal(`${p}: '${p}' is outside repository at '${root}'`);
    return rel;
  };
  /** A repository-relative path as git prints it to a user standing in `cwd`. */
  repo.show = (rel) => relative(cwd, `${root}/${rel}`) || ".";
  return repo;
}

async function headOid(repo) {
  return git.resolveRef({ fs: repo.fs, dir: repo.dir, ref: "HEAD" }).catch(() => null);
}
async function currentBranch(repo) {
  return git.currentBranch({ fs: repo.fs, dir: repo.dir, fullname: false }).catch(() => null);
}

/** `HEAD`, `HEAD~2`, `HEAD^`, a branch, a tag, a full or short sha → a commit oid. */
async function resolveRev(repo, rev) {
  const m = /^(.*?)((?:[~^]\d*)*)$/.exec(String(rev));
  const base = m[1] || "HEAD";
  let oid = await git.resolveRef({ fs: repo.fs, dir: repo.dir, ref: base }).catch(() => null);
  if (!oid && /^[0-9a-f]{4,40}$/i.test(base)) oid = await git.expandOid({ fs: repo.fs, dir: repo.dir, oid: base.toLowerCase(), cache: repo.cache }).catch(() => null);
  if (!oid) throw fatal(`ambiguous argument '${rev}': unknown revision or path not in the working tree.`);
  for (const step of m[2].match(/[~^]\d*/g) ?? []) {
    const n = step.length > 1 ? Number(step.slice(1)) : 1;
    for (let i = 0; i < (step[0] === "~" ? n : 1); i++) {
      const { commit } = await git.readCommit({ fs: repo.fs, dir: repo.dir, oid, cache: repo.cache });
      const parent = commit.parent[step[0] === "^" ? n - 1 : 0];
      if (!parent) throw fatal(`ambiguous argument '${rev}': unknown revision or path not in the working tree.`);
      oid = parent;
    }
  }
  return oid;
}

/** Path → {oid, mode} for every blob a commit's tree holds; empty for none. */
async function treeMap(repo, commit) {
  const map = new Map();
  if (!commit) return map;
  await git.walk({
    fs: repo.fs, dir: repo.dir, cache: repo.cache, trees: [git.TREE({ ref: commit })],
    map: async (filepath, [entry]) => {
      if (filepath === "." || !entry) return undefined;
      const type = await entry.type();
      if (type === "tree") return undefined;
      if (type === "blob") map.set(filepath, { oid: await entry.oid(), mode: await entry.mode() });
      return null;
    },
  });
  return map;
}

/** Path → {oid, mode} for every index entry. */
async function indexMap(repo) {
  const map = new Map();
  await git.walk({
    fs: repo.fs, dir: repo.dir, cache: repo.cache, trees: [git.STAGE()],
    map: async (filepath, [entry]) => {
      if (filepath === "." || !entry) return undefined;
      if ((await entry.type()) === "tree") return undefined;
      map.set(filepath, { oid: await entry.oid(), mode: await entry.mode() });
      return null;
    },
  }).catch(() => {});
  return map;
}

// ── the working tree ─────────────────────────────────────────────────────

/** .gitignore rules, nested, plus .git/info/exclude; the deepest match decides. */
async function ignoreRules(repo) {
  const rules = [];
  const load = async (base, file) => {
    const text = await repo.raw.readFile(file, "utf8").catch(() => null);
    if (text !== null) rules.push({ base, ig: ignore().add(text) });
  };
  await load("", `${repo.dir}/.git/info/exclude`);
  return {
    enter: (base) => load(base, `${repo.dir}/${base ? `${base}/` : ""}.gitignore`),
    ignored(rel, isDir) {
      let out = false;
      for (const { base, ig } of rules) {
        if (base && !rel.startsWith(`${base}/`)) continue;
        const r = ig.test(`${base ? rel.slice(base.length + 1) : rel}${isDir ? "/" : ""}`);
        if (r.ignored) out = true;
        else if (r.unignored) out = false;
      }
      return out;
    },
  };
}

/**
 * Every file in the working tree as {symlink, exec}, and which untracked
 * files are not ignored. An ignored directory that holds nothing tracked is
 * not walked at all: a `node_modules` is thousands of files nobody asked about.
 */
async function scanWorkdir(repo, index) {
  const trackedDirs = new Set();
  for (const path of index.keys()) {
    const segs = path.split("/");
    for (let i = 1; i < segs.length; i++) trackedDirs.add(segs.slice(0, i).join("/"));
  }
  const rules = await ignoreRules(repo);
  const files = new Map();
  const untracked = [];
  const walk = async (rel) => {
    let names;
    try { names = await repo.raw.readdir(rel ? `${repo.dir}/${rel}` : repo.dir); } catch { return; }
    if (names.includes(".gitignore")) await rules.enter(rel);
    for (const name of [...names].sort()) {
      if (name === ".git") continue;
      const path = joinRel(rel, name);
      let st;
      try { st = await repo.raw.lstat(`${repo.dir}/${path}`); } catch { continue; }
      if (st.isDirectory) {
        if (rules.ignored(path, true) && !trackedDirs.has(path)) continue;
        await walk(path);
        continue;
      }
      files.set(path, { symlink: !!st.isSymbolicLink, exec: ((st.mode ?? 0) & 0o111) !== 0 });
      if (!index.has(path) && !rules.ignored(path, false)) untracked.push(path);
    }
  };
  await walk("");
  return { files, untracked, trackedDirs, rules };
}

/** The bytes git would store for a working-tree path. */
async function workBytes(repo, rel, info) {
  const abs = `${repo.dir}/${rel}`;
  if (info?.symlink) return toBytes(await repo.raw.readlink(abs));
  return toBytes(await repo.raw.readFileBuffer(abs));
}
async function workOid(repo, rel, info) {
  return (await git.hashBlob({ object: await workBytes(repo, rel, info) })).oid;
}
const workMode = (info) => (info?.symlink ? 0o120000 : info?.exec ? 0o100755 : 0o100644);

async function blobBytes(repo, oid) {
  if (!oid || oid === ZERO) return new Uint8Array();
  return (await git.readBlob({ fs: repo.fs, dir: repo.dir, oid, cache: repo.cache })).blob;
}

/**
 * HEAD, the index and the working tree, compared by object id.
 * Each entry is `{ path, x, y }` with git's porcelain letters; `untracked`
 * lists every untracked, non-ignored file.
 */
async function computeStatus(repo) {
  const commit = await headOid(repo);
  const head = await treeMap(repo, commit);
  const index = await indexMap(repo);
  const work = await scanWorkdir(repo, index);
  const entries = [];
  const workOids = new Map();
  for (const path of [...new Set([...head.keys(), ...index.keys()])].sort()) {
    const h = head.get(path);
    const i = index.get(path);
    const w = work.files.get(path);
    let x = " ";
    if (!h && i) x = "A";
    else if (h && !i) x = "D";
    else if (h.oid !== i.oid || h.mode !== i.mode) x = "M";
    let y = " ";
    if (i) {
      if (!w) y = "D";
      else {
        const oid = await workOid(repo, path, w);
        workOids.set(path, oid);
        if (oid !== i.oid) y = "M";
      }
    }
    if (x !== " " || y !== " ") entries.push({ path, x, y });
  }
  return { commit, head, index, work, entries, untracked: work.untracked, workOids };
}

/** Untracked files as git shows them by default: a wholly untracked directory is one `dir/`. */
function collapseUntracked(untracked, trackedDirs) {
  const out = new Set();
  for (const path of untracked) {
    const segs = path.split("/");
    let shown = path;
    for (let i = 1; i < segs.length; i++) {
      const dir = segs.slice(0, i).join("/");
      if (!trackedDirs.has(dir)) { shown = `${dir}/`; break; }
    }
    out.add(shown);
  }
  return [...out].sort();
}

// ── diffs ────────────────────────────────────────────────────────────────

const isBinary = (bytes) => bytes.subarray(0, 8000).includes(0);
const range = (start, count) => (count === 0 ? `${start - 1},0` : count === 1 ? `${start}` : `${start},${count}`);

/**
 * One file's change: `{path, old, new}` with `{oid, mode, bytes}` on each
 * side or null for none. Returns the patch text and the line counts.
 */
function filePatch({ path, old, neu }, context = 3) {
  const lines = [`diff --git a/${path} b/${path}`];
  if (!old) lines.push(`new file mode ${modeString(neu.mode)}`);
  else if (!neu) lines.push(`deleted file mode ${modeString(old.mode)}`);
  else if (old.mode !== neu.mode) lines.push(`old mode ${modeString(old.mode)}`, `new mode ${modeString(neu.mode)}`);
  const sameMode = old && neu && old.mode === neu.mode;
  lines.push(`index ${short(old?.oid ?? ZERO)}..${short(neu?.oid ?? ZERO)}${sameMode ? ` ${modeString(old.mode)}` : ""}`);
  const a = old ? `a/${path}` : "/dev/null";
  const b = neu ? `b/${path}` : "/dev/null";
  const oldBytes = old?.bytes ?? new Uint8Array();
  const newBytes = neu?.bytes ?? new Uint8Array();
  if (isBinary(oldBytes) || isBinary(newBytes)) {
    lines.push(`Binary files ${a} and ${b} differ`);
    return { text: `${lines.join("\n")}\n`, added: 0, removed: 0, binary: true, oldSize: oldBytes.length, newSize: newBytes.length };
  }
  const hunks = structuredPatch(path, path, decoder.decode(oldBytes), decoder.decode(newBytes), "", "", { context }).hunks;
  if (!hunks.length) return { text: old && neu && old.mode !== neu.mode ? `${lines.join("\n")}\n` : "", added: 0, removed: 0 };
  lines.push(`--- ${a}`, `+++ ${b}`);
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    lines.push(`@@ -${range(h.oldStart, h.oldLines)} +${range(h.newStart, h.newLines)} @@`);
    for (const l of h.lines) {
      if (l[0] === "+") added++;
      else if (l[0] === "-") removed++;
      lines.push(l);
    }
  }
  return { text: `${lines.join("\n")}\n`, added, removed };
}

/** `--stat`: ` path | N +++--` per file and git's summary line. */
function statText(rows) {
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.path.length));
  const changes = rows.map((r) => (r.binary ? 0 : r.added + r.removed));
  const countWidth = Math.max(...rows.map((r, i) => (r.binary ? 3 : String(changes[i]).length)));
  const max = Math.max(1, ...changes);
  const graph = Math.min(max, Math.max(10, 72 - width - countWidth));
  const lines = rows.map((r, i) => {
    if (r.binary) return ` ${r.path.padEnd(width)} | Bin ${r.oldSize} -> ${r.newSize} bytes`;
    const scale = max > graph ? graph / max : 1;
    const plus = Math.round(r.added * scale) || (r.added ? 1 : 0);
    const minus = Math.round(r.removed * scale) || (r.removed ? 1 : 0);
    return ` ${r.path.padEnd(width)} | ${String(changes[i]).padStart(countWidth)}${changes[i] ? ` ${"+".repeat(plus)}${"-".repeat(minus)}` : ""}`;
  });
  return `${lines.join("\n")}\n${summaryLine(rows)}\n`;
}
function summaryLine(rows) {
  const ins = rows.reduce((n, r) => n + r.added, 0);
  const del = rows.reduce((n, r) => n + r.removed, 0);
  return ` ${plural(rows.length, "file changed", "files changed")}${ins ? `, ${plural(ins, "insertion(+)", "insertions(+)")}` : ""}${del ? `, ${plural(del, "deletion(-)", "deletions(-)")}` : ""}`;
}

/** Side of a diff from a {oid, mode} map entry. */
async function side(repo, entry) {
  return entry ? { oid: entry.oid, mode: entry.mode, bytes: await blobBytes(repo, entry.oid) } : null;
}
async function workSide(repo, path, info) {
  if (!info) return null;
  const bytes = await workBytes(repo, path, info);
  return { oid: (await git.hashBlob({ object: bytes })).oid, mode: workMode(info), bytes };
}

/** Render a list of changed files in the output form a diff command asked for. */
function renderDiff(changes, opts, repo) {
  const rows = [];
  let patch = "";
  for (const c of changes) {
    const p = filePatch(c, opts.context);
    if (!p.text && !(c.old && c.neu && c.old.oid !== c.neu.oid)) continue;
    rows.push({ path: opts.relative ? repo.show(c.path) : c.path, status: !c.old ? "A" : !c.neu ? "D" : "M", ...p });
    patch += p.text;
  }
  if (opts.nameOnly) return rows.map((r) => `${r.path}\n`).join("");
  if (opts.nameStatus) return rows.map((r) => `${r.status}\t${r.path}\n`).join("");
  if (opts.numstat) return rows.map((r) => `${r.binary ? "-" : r.added}\t${r.binary ? "-" : r.removed}\t${r.path}\n`).join("");
  if (opts.shortstat) return rows.length ? `${summaryLine(rows)}\n` : "";
  if (opts.stat) return statText(rows);
  return patch;
}

/** Parse the output-shape flags every diff-producing command shares. Returns the rest. */
function diffFlags(args, opts) {
  const rest = [];
  for (const a of args) {
    if (a === "--stat") opts.stat = true;
    else if (a === "--name-only") opts.nameOnly = true;
    else if (a === "--name-status") opts.nameStatus = true;
    else if (a === "--numstat") opts.numstat = true;
    else if (a === "--shortstat") opts.shortstat = true;
    else if (a === "--no-color" || a === "--color=never" || a === "--no-ext-diff" || a === "-p" || a === "--patch") continue;
    else if (/^-U\d+$/.test(a)) opts.context = Number(a.slice(2));
    else if (/^--unified=\d+$/.test(a)) opts.context = Number(a.split("=")[1]);
    else rest.push(a);
  }
  return rest;
}

/** Split `args` at `--` into revisions/options and pathspecs. */
function splitDashDash(args) {
  const i = args.indexOf("--");
  return i === -1 ? [args, null] : [args.slice(0, i), args.slice(i + 1)];
}

// ── dates and identities ─────────────────────────────────────────────────

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** git's default date: `Tue Oct 6 17:43:00 2026 +0200`, in the signature's own zone. */
function gitDate({ timestamp, timezoneOffset = 0 }) {
  const d = new Date((timestamp - timezoneOffset * 60) * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  const off = Math.abs(timezoneOffset);
  const zone = `${timezoneOffset <= 0 ? "+" : "-"}${pad(Math.floor(off / 60))}${pad(off % 60)}`;
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()} ${zone}`;
}
function relativeDate(timestamp) {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
  const unit = [[31536000, "year"], [2592000, "month"], [604800, "week"], [86400, "day"], [3600, "hour"], [60, "minute"]].find(([n]) => s >= n);
  if (!unit) return `${s} seconds ago`;
  const n = Math.floor(s / unit[0]);
  return `${n} ${unit[1]}${n === 1 ? "" : "s"} ago`;
}

/** Name and email: `--author`, then GIT_AUTHOR_*, then `-c`/config user.*, then Kortix's. */
async function identity(repo, kind, explicit) {
  if (explicit) return explicit;
  const env = (k) => repo.env(k);
  const config = async (k) => repo.overrides[k] ?? (await git.getConfig({ fs: repo.fs, dir: repo.dir, path: k }).catch(() => undefined));
  const name = env(`GIT_${kind}_NAME`) || (await config("user.name")) || DEFAULT_AUTHOR.name;
  const email = env(`GIT_${kind}_EMAIL`) || (await config("user.email")) || DEFAULT_AUTHOR.email;
  return { name, email };
}

/** git's message cleanup: trailing spaces, leading and trailing blank lines, one final newline. */
function cleanMessage(text) {
  const lines = String(text).split("\n").map((l) => l.replace(/\s+$/, ""));
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines.at(-1)) lines.pop();
  return lines.length ? `${lines.join("\n")}\n` : "";
}
const subjectOf = (message) => String(message).split("\n")[0];

// ── log formatting ───────────────────────────────────────────────────────

/** `--format=X` / `tformat:X` end each entry with a newline; `--pretty=format:X` only separates them. */
function parseFormat(arg) {
  const m = /^--(pretty|format)=(format:|tformat:)?(.*)$/s.exec(arg);
  const separator = m[2] === "format:";
  return `custom${separator ? "-sep" : ""}:${m[3]}`;
}

function formatCommit({ oid, commit }, format, refs = "") {
  if (format === "oneline") return `${short(oid)}${refs} ${subjectOf(commit.message)}\n`;
  if (format.startsWith("custom")) {
    const body = commit.message.split("\n").slice(1).join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
    const map = {
      H: oid, h: short(oid), T: commit.tree, t: short(commit.tree), P: commit.parent.join(" "), p: commit.parent.map(short).join(" "),
      s: subjectOf(commit.message), b: body ? `${body}\n` : "", B: commit.message,
      an: commit.author.name, ae: commit.author.email, ad: gitDate(commit.author), ar: relativeDate(commit.author.timestamp), at: String(commit.author.timestamp),
      cn: commit.committer.name, ce: commit.committer.email, cd: gitDate(commit.committer), cr: relativeDate(commit.committer.timestamp), ct: String(commit.committer.timestamp),
      d: refs, D: refs.replace(/^ \(|\)$/g, ""), n: "\n", "%": "%",
    };
    const text = format.slice(format.indexOf(":") + 1).replace(/%(an|ae|ad|ar|at|cn|ce|cd|cr|ct|[HhTtPpsbBdDn%])/g, (_, k) => map[k]);
    return format.startsWith("custom-sep") ? text : `${text}\n`;
  }
  const msg = commit.message.replace(/\n+$/, "").split("\n").map((l) => (l ? `    ${l}` : "")).join("\n");
  return `commit ${oid}${refs}\n${commit.parent.length > 1 ? `Merge: ${commit.parent.map(short).join(" ")}\n` : ""}Author: ${commit.author.name} <${commit.author.email}>\nDate:   ${gitDate(commit.author)}\n\n${msg}\n`;
}

/** ` (HEAD -> main, origin/main)` decorations for a commit, as `--decorate` prints them. */
async function decorations(repo) {
  const out = new Map();
  const add = (oid, name) => out.set(oid, [...(out.get(oid) ?? []), name]);
  const head = await headOid(repo);
  const branch = await currentBranch(repo);
  for (const b of await git.listBranches({ fs: repo.fs, dir: repo.dir }).catch(() => [])) {
    const oid = await git.resolveRef({ fs: repo.fs, dir: repo.dir, ref: b }).catch(() => null);
    if (oid) add(oid, b === branch ? `HEAD -> ${b}` : b);
  }
  if (head && !branch) add(head, "HEAD");
  for (const remote of await git.listRemotes({ fs: repo.fs, dir: repo.dir }).catch(() => [])) {
    for (const b of await git.listBranches({ fs: repo.fs, dir: repo.dir, remote: remote.remote }).catch(() => [])) {
      if (b === "HEAD") continue;
      const oid = await git.resolveRef({ fs: repo.fs, dir: repo.dir, ref: `refs/remotes/${remote.remote}/${b}` }).catch(() => null);
      if (oid) add(oid, `${remote.remote}/${b}`);
    }
  }
  return (oid) => (out.has(oid) ? ` (${out.get(oid).sort((a, b) => (a.startsWith("HEAD") ? -1 : b.startsWith("HEAD") ? 1 : 0)).join(", ")})` : "");
}

// ── subcommands ──────────────────────────────────────────────────────────

async function cmdStatus(repo, args) {
  let mode = "long";
  let branchLine = false;
  let untrackedMode = "normal";
  const specs = [];
  for (const a of args) {
    if (a === "--porcelain" || a === "--porcelain=v1") mode = "porcelain";
    else if (a === "-s" || a === "--short") mode = mode === "porcelain" ? mode : "short";
    else if (a === "-b" || a === "--branch") branchLine = true;
    else if (a === "-sb" || a === "-bs") { mode = "short"; branchLine = true; }
    else if (a === "-u" || a === "-uall" || a === "--untracked-files" || a === "--untracked-files=all") untrackedMode = "all";
    else if (a === "-uno" || a === "--untracked-files=no") untrackedMode = "no";
    else if (a === "-unormal" || a === "--untracked-files=normal") untrackedMode = "normal";
    else if (a === "--long" || a === "--no-renames" || a === "--ignore-submodules") continue;
    else if (a === "--") continue;
    else if (a.startsWith("-")) throw usageError(`unknown option \`${a.replace(/^-+/, "")}'`);
    else specs.push(repo.spec(a));
  }
  const st = await computeStatus(repo);
  const entries = st.entries.filter((e) => matchesAny(e.path, specs));
  const untrackedFiles = st.untracked.filter((p) => matchesAny(p, specs));
  const untracked = untrackedMode === "no" ? [] : untrackedMode === "all" ? untrackedFiles : collapseUntracked(untrackedFiles, st.work.trackedDirs);
  const branch = await currentBranch(repo);
  const shown = (p) => (mode === "porcelain" ? p : repo.show(p));

  if (mode !== "long") {
    const lines = [];
    if (branchLine) lines.push(!st.commit ? `## No commits yet on ${branch}` : branch ? `## ${branch}` : "## HEAD (no branch)");
    for (const e of entries) lines.push(`${e.x}${e.y} ${shown(e.path)}`);
    for (const p of untracked) lines.push(`?? ${shown(p.endsWith("/") ? p.slice(0, -1) : p)}${p.endsWith("/") ? "/" : ""}`);
    return result(lines.length ? `${lines.join("\n")}\n` : "");
  }

  const label = { A: "new file:   ", M: "modified:   ", D: "deleted:    " };
  const staged = entries.filter((e) => e.x !== " ");
  const unstaged = entries.filter((e) => e.y !== " ");
  // git's layout: the branch line, then each section followed by one blank
  // line, then the closing advice. No blank line between the branch line and
  // the first section unless the branch has no commits yet.
  const out = [branch ? `On branch ${branch}` : `HEAD detached at ${short(st.commit)}`];
  if (!st.commit) out.push("", "No commits yet", "");
  if (staged.length) {
    out.push("Changes to be committed:", st.commit ? '  (use "git restore --staged <file>..." to unstage)' : '  (use "git rm --cached <file>..." to unstage)');
    for (const e of staged) out.push(`\t${label[e.x]}${repo.show(e.path)}`);
    out.push("");
  }
  if (unstaged.length) {
    out.push("Changes not staged for commit:", `  (use "git ${unstaged.some((e) => e.y === "D") ? "add/rm" : "add"} <file>..." to update what will be committed)`, '  (use "git restore <file>..." to discard changes in working directory)');
    for (const e of unstaged) out.push(`\t${label[e.y]}${repo.show(e.path)}`);
    out.push("");
  }
  if (untracked.length) {
    out.push("Untracked files:", '  (use "git add <file>..." to include in what will be committed)');
    for (const p of untracked) out.push(`\t${repo.show(p.replace(/\/$/, ""))}${p.endsWith("/") ? "/" : ""}`);
    out.push("");
  }
  if (!staged.length && unstaged.length) out.push('no changes added to commit (use "git add" and/or "git commit -a")');
  else if (!staged.length && untracked.length) out.push('nothing added to commit but untracked files present (use "git add" to track)');
  else if (!staged.length) out.push(st.commit ? "nothing to commit, working tree clean" : 'nothing to commit (create/copy files and use "git add" to track)');
  return result(`${out.join("\n")}\n`);
}

async function cmdDiff(repo, args) {
  const opts = { context: 3, relative: false };
  const [left, paths] = splitDashDash(diffFlags(args, opts));
  let cached = false;
  const revs = [];
  const specs = (paths ?? []).map(repo.spec);
  for (const a of left) {
    if (a === "--cached" || a === "--staged") cached = true;
    else if (a.startsWith("-")) throw usageError(`unknown option \`${a.replace(/^-+/, "")}'`);
    else if (a.includes("..")) revs.push(...a.split(/\.\.\.?/).map((r) => r || "HEAD"));
    else if (paths === null && !(await git.resolveRef({ fs: repo.fs, dir: repo.dir, ref: a }).catch(() => null)) && !/^HEAD([~^]\d*)*$/.test(a) && !/^[0-9a-f]{7,40}$/.test(a)) specs.push(repo.spec(a));
    else revs.push(a);
  }
  if (revs.length > 2) throw usageError("at most two revisions are supported");
  const index = await indexMap(repo);
  const changes = [];
  if (revs.length === 2) {
    const a = await treeMap(repo, await resolveRev(repo, revs[0]));
    const b = await treeMap(repo, await resolveRev(repo, revs[1]));
    for (const path of [...new Set([...a.keys(), ...b.keys()])].sort()) {
      if (!matchesAny(path, specs) || a.get(path)?.oid === b.get(path)?.oid) continue;
      changes.push({ path, old: await side(repo, a.get(path)), neu: await side(repo, b.get(path)) });
    }
  } else if (cached) {
    const base = await treeMap(repo, revs[0] ? await resolveRev(repo, revs[0]) : await headOid(repo));
    for (const path of [...new Set([...base.keys(), ...index.keys()])].sort()) {
      const h = base.get(path);
      const i = index.get(path);
      if (!matchesAny(path, specs) || (h?.oid === i?.oid && h?.mode === i?.mode)) continue;
      changes.push({ path, old: await side(repo, h), neu: await side(repo, i) });
    }
  } else {
    const work = await scanWorkdir(repo, index);
    const base = revs[0] ? await treeMap(repo, await resolveRev(repo, revs[0])) : index;
    const paths = revs[0] ? new Set([...base.keys(), ...index.keys()]) : new Set(index.keys());
    for (const path of [...paths].sort()) {
      if (!matchesAny(path, specs)) continue;
      const b = base.get(path);
      const w = work.files.get(path);
      if (!b && !w) continue;
      const neu = await workSide(repo, path, w);
      // The cell's tree does not keep mode bits across a restore, so a
      // working file's mode is not evidence of a change (status ignores it too).
      if (b && neu) neu.mode = b.mode;
      if (b && neu && b.oid === neu.oid) continue;
      changes.push({ path, old: await side(repo, b), neu });
    }
  }
  return result(renderDiff(changes, opts, repo));
}

async function cmdLog(repo, args) {
  let max = Infinity;
  let format = "medium";
  let decorate = false;
  const [left, paths] = splitDashDash(args);
  const revs = [];
  for (let i = 0; i < left.length; i++) {
    const a = left[i];
    if (a === "-n" || a === "--max-count") max = Number(left[++i]);
    else if (/^-n\d+$/.test(a)) max = Number(a.slice(2));
    else if (/^-\d+$/.test(a)) max = Number(a.slice(1));
    else if (/^--max-count=\d+$/.test(a)) max = Number(a.split("=")[1]);
    // No decoration unless asked: git decorates only on a terminal, and a
    // tool's output never is one.
    else if (a === "--oneline" || a === "--pretty=oneline" || a === "--format=oneline") format = "oneline";
    else if (["--pretty", "--pretty=medium", "--format=medium", "--pretty=short", "--pretty=full", "--pretty=fuller"].includes(a)) format = "medium";
    else if (/^--(pretty|format)=/.test(a)) format = parseFormat(a);
    else if (a === "--decorate" || a === "--decorate=short") decorate = true;
    else if (a === "--no-decorate" || a === "--no-color" || a === "--no-merges" || a === "--first-parent") continue;
    else if (a.startsWith("-")) throw usageError(`unknown option \`${a.replace(/^-+/, "")}' (supported: -n N, --oneline, --format=..., --decorate, -- <path>)`);
    else revs.push(a);
  }
  if (!Number.isFinite(max) && max !== Infinity) throw usageError("-n needs a number");
  const start = revs[0] ? await resolveRev(repo, revs[0]) : await headOid(repo);
  if (!start) {
    const branch = await currentBranch(repo);
    throw fatal(`your current branch '${branch ?? "HEAD"}' does not have any commits yet`);
  }
  const filepath = paths?.length ? repo.spec(paths[0]) : undefined;
  const commits = await git.log({ fs: repo.fs, dir: repo.dir, ref: start, cache: repo.cache, ...(Number.isFinite(max) && !filepath ? { depth: max } : {}), ...(filepath ? { filepath } : {}) }).catch((e) => {
    if (filepath) return [];
    throw e;
  });
  const deco = decorate ? await decorations(repo) : () => "";
  const shown = commits.slice(0, Number.isFinite(max) ? max : undefined);
  const sep = format === "medium" || format.startsWith("custom-sep") ? "\n" : "";
  return result(shown.map((c) => formatCommit(c, format, deco(c.oid))).join(sep));
}

async function cmdShow(repo, args) {
  const opts = { context: 3 };
  let format = "medium";
  let noPatch = false;
  const rest = [];
  for (const a of diffFlags(args, opts)) {
    if (a === "--oneline" || a === "--pretty=oneline") format = "oneline";
    else if (/^--(pretty|format)=/.test(a)) format = parseFormat(a);
    else if (a === "-s" || a === "--no-patch") noPatch = true;
    else if (a.startsWith("-")) throw usageError(`unknown option \`${a.replace(/^-+/, "")}'`);
    else rest.push(a);
  }
  const target = rest[0] ?? "HEAD";
  const colon = target.indexOf(":");
  if (colon !== -1) {
    const oid = await resolveRev(repo, target.slice(0, colon) || "HEAD");
    const filepath = target.slice(colon + 1).replace(/^\.\//, "");
    const { blob } = await git.readBlob({ fs: repo.fs, dir: repo.dir, oid, filepath, cache: repo.cache })
      .catch(() => { throw fatal(`path '${filepath}' does not exist in '${target.slice(0, colon) || "HEAD"}'`); });
    return result(decoder.decode(blob));
  }
  const oid = await resolveRev(repo, target);
  const { commit } = await git.readCommit({ fs: repo.fs, dir: repo.dir, oid, cache: repo.cache });
  const head = formatCommit({ oid, commit }, format);
  if (noPatch) return result(head);
  const parent = commit.parent[0] ? await treeMap(repo, commit.parent[0]).catch(() => new Map()) : new Map();
  const mine = await treeMap(repo, oid);
  const changes = [];
  for (const path of [...new Set([...parent.keys(), ...mine.keys()])].sort()) {
    if (parent.get(path)?.oid === mine.get(path)?.oid) continue;
    changes.push({ path, old: await side(repo, parent.get(path)), neu: await side(repo, mine.get(path)) });
  }
  const body = renderDiff(changes, opts, repo);
  return result(`${head}${body ? `\n${body}` : ""}`);
}

async function cmdAdd(repo, args) {
  let all = false;
  let update = false;
  let force = false;
  let dryRun = false;
  const specs = [];
  for (const a of args) {
    if (a === "-A" || a === "--all") all = true;
    else if (a === "-u" || a === "--update") update = true;
    else if (a === "-f" || a === "--force") force = true;
    else if (a === "-n" || a === "--dry-run") dryRun = true;
    else if (a === "-v" || a === "--verbose" || a === "--") continue;
    else if (a.startsWith("-")) throw usageError(`unknown option \`${a.replace(/^-+/, "")}' (supported: -A, -u, -f, -n, <path>...)`);
    else specs.push(a);
  }
  if (!specs.length && !all && !update) {
    return result("", "Nothing specified, nothing added.\nhint: Maybe you wanted to say 'git add .'?\n", 0);
  }
  const rel = specs.length ? specs.map(repo.spec) : [""];
  const st = await computeStatus(repo);
  const toAdd = new Set();
  const toRemove = new Set();
  const ignoredHits = [];
  for (const e of st.entries) {
    if (!matchesAny(e.path, rel) || e.y === " ") continue;
    (e.y === "D" ? toRemove : toAdd).add(e.path);
  }
  if (!update) for (const p of st.untracked) if (matchesAny(p, rel)) toAdd.add(p);
  const untrackedSet = new Set(st.untracked);
  for (let i = 0; i < rel.length; i++) {
    const spec = rel[i];
    // A file named outright that the walk saw but called ignored.
    if (st.work.files.has(spec) && !st.index.has(spec) && !untrackedSet.has(spec)) {
      if (force) toAdd.add(spec);
      else ignoredHits.push(repo.show(spec));
      continue;
    }
    if ([...st.index.keys(), ...st.work.files.keys()].some((p) => under(p, spec))) continue;
    // Not tracked and not walked: inside an ignored directory, an empty
    // directory, or nothing at all.
    const stat = await repo.raw.stat(spec ? `${repo.dir}/${spec}` : repo.dir).catch(() => null);
    if (!stat) throw fatal(`pathspec '${specs[i] ?? spec}' did not match any files`);
    const ignoredHere = st.work.rules.ignored(spec, stat.isDirectory) || spec.split("/").slice(0, -1).some((_, j, segs) => st.work.rules.ignored(segs.slice(0, j + 1).join("/"), true));
    if (!ignoredHere) continue;
    if (!force) { ignoredHits.push(repo.show(spec)); continue; }
    if (!stat.isDirectory) { toAdd.add(spec); continue; }
    const walk = async (rel) => {
      for (const name of await repo.raw.readdir(`${repo.dir}/${rel}`).catch(() => [])) {
        const child = `${rel}/${name}`;
        const cs = await repo.raw.lstat(`${repo.dir}/${child}`).catch(() => null);
        if (cs?.isDirectory) await walk(child);
        else if (cs) toAdd.add(child);
      }
    };
    await walk(spec);
  }
  const added = [...toAdd].sort();
  const removed = [...toRemove].sort();
  if (!dryRun) {
    // One call for the whole list: isomorphic-git then writes the index once
    // instead of once per file (300 files: 671 ms one by one).
    if (added.length) await git.add({ fs: repo.fs, dir: repo.dir, filepath: added, force: true, cache: repo.cache });
    for (const filepath of removed) await git.remove({ fs: repo.fs, dir: repo.dir, filepath, cache: repo.cache });
  }
  const stdout = dryRun ? [...added.map((p) => `add '${p}'\n`), ...removed.map((p) => `remove '${p}'\n`)].join("") : "";
  if (ignoredHits.length) {
    return result(stdout, `The following paths are ignored by one of your .gitignore files:\n${ignoredHits.join("\n")}\nhint: Use -f if you really want to add them.\n`, 1);
  }
  return result(stdout);
}

async function cmdRm(repo, args) {
  let cached = false;
  let quiet = false;
  const specs = [];
  for (const a of args) {
    if (a === "--cached") cached = true;
    else if (a === "-r" || a === "-f" || a === "--force" || a === "--") continue;
    else if (a === "-q" || a === "--quiet") quiet = true;
    else if (a.startsWith("-")) throw usageError(`unknown option \`${a.replace(/^-+/, "")}'`);
    else specs.push(a);
  }
  if (!specs.length) throw usageError("No pathspec was given. Which files should I remove?");
  const index = await indexMap(repo);
  const out = [];
  for (const s of specs) {
    const spec = repo.spec(s);
    const hits = [...index.keys()].filter((p) => under(p, spec));
    if (!hits.length) throw fatal(`pathspec '${s}' did not match any files`);
    for (const filepath of hits) {
      await git.remove({ fs: repo.fs, dir: repo.dir, filepath, cache: repo.cache });
      if (!cached) await repo.raw.rm(`${repo.dir}/${filepath}`, { force: true });
      out.push(`rm '${filepath}'`);
    }
  }
  return result(quiet ? "" : `${out.join("\n")}\n`);
}

async function cmdCommit(repo, args) {
  const messages = [];
  let all = false;
  let allowEmpty = false;
  let amend = false;
  let quiet = false;
  let author = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-m" || a === "--message") { if (i + 1 >= args.length) throw usageError("switch `m' requires a value"); messages.push(args[++i]); }
    else if (a.startsWith("--message=")) messages.push(a.slice(10));
    else if (/^-[a-zA-Z]*m.+/.test(a) && !a.startsWith("--")) {
      const at = a.indexOf("m");
      for (const f of a.slice(1, at)) if (f === "a") all = true; else if (f === "q") quiet = true; else throw usageError(`unknown switch \`${f}'`);
      messages.push(a.slice(at + 1));
    } else if (/^-[aq]*m$/.test(a)) {
      for (const f of a.slice(1, -1)) if (f === "a") all = true; else quiet = true;
      if (i + 1 >= args.length) throw usageError("switch `m' requires a value");
      messages.push(args[++i]);
    } else if (a === "-a" || a === "--all") all = true;
    else if (a === "-q" || a === "--quiet") quiet = true;
    else if (a === "--allow-empty") allowEmpty = true;
    else if (a === "--amend") amend = true;
    else if (a === "--no-verify" || a === "-n" || a === "--no-edit") continue;
    else if (a === "-F" || a === "--file") {
      const file = args[++i];
      const text = file === "-" ? repo.stdin : await repo.raw.readFile(absolute(repo.cwd, file), "utf8").catch(() => { throw fatal(`could not read log file '${file}'`); });
      messages.push(text);
    } else if (a.startsWith("--author=")) {
      const m = /^(.*?)\s*<([^>]*)>\s*$/.exec(a.slice(9));
      if (!m) throw fatal(`--author '${a.slice(9)}' is not 'Name <email>'`);
      author = { name: m[1], email: m[2] };
    } else throw usageError(`unknown option \`${a.replace(/^-+/, "")}' (supported: -m, -a, -F, --amend, --allow-empty, --author=)`);
  }
  const head = await headOid(repo);
  let message = cleanMessage(messages.join("\n\n"));
  if (!message && amend && head) message = (await git.readCommit({ fs: repo.fs, dir: repo.dir, oid: head })).commit.message;
  if (!message) throw new GitExit("Aborting commit due to empty commit message. Pass it with -m \"<message>\" (this shell has no editor).", 1);
  if (all) {
    const st = await computeStatus(repo);
    for (const e of st.entries) {
      if (e.y === "M") await git.add({ fs: repo.fs, dir: repo.dir, filepath: e.path, cache: repo.cache });
      if (e.y === "D") await git.remove({ fs: repo.fs, dir: repo.dir, filepath: e.path, cache: repo.cache });
    }
  }
  // What the commit will record, against what it replaces.
  const index = await indexMap(repo);
  const baseCommit = amend && head ? (await git.readCommit({ fs: repo.fs, dir: repo.dir, oid: head })).commit.parent[0] ?? null : head;
  const base = await treeMap(repo, baseCommit).catch(() => new Map());
  const changes = [];
  for (const path of [...new Set([...base.keys(), ...index.keys()])].sort()) {
    const b = base.get(path);
    const i = index.get(path);
    if (b?.oid === i?.oid && b?.mode === i?.mode) continue;
    changes.push({ path, old: await side(repo, b), neu: await side(repo, i) });
  }
  if (!changes.length && !allowEmpty && !amend) {
    const status = await cmdStatus(repo, []);
    throw new GitExit("", 1, status.stdout);
  }
  const who = await identity(repo, "AUTHOR", author);
  const committer = await identity(repo, "COMMITTER", null);
  const oid = await git.commit({ fs: repo.fs, dir: repo.dir, message, author: who, committer, amend: amend && !!head, cache: repo.cache });
  if (quiet) return result();
  const branch = await currentBranch(repo);
  const rows = changes.map((c) => ({ ...filePatch(c), path: c.path, created: !c.old, deleted: !c.neu, mode: (c.neu ?? c.old).mode }));
  const lines = [`[${branch ?? "detached HEAD"}${head ? "" : " (root-commit)"} ${short(oid)}] ${subjectOf(message)}`];
  if (rows.length) lines.push(summaryLine(rows));
  for (const r of rows) {
    if (r.created) lines.push(` create mode ${modeString(r.mode)} ${r.path}`);
    if (r.deleted) lines.push(` delete mode ${modeString(r.mode)} ${r.path}`);
  }
  return result(`${lines.join("\n")}\n`);
}

/** Write the index's (or a tree's) copy of a path into the working tree. */
async function writeWork(repo, path, entry) {
  const abs = `${repo.dir}/${path}`;
  const bytes = await blobBytes(repo, entry.oid);
  await repo.raw.mkdir(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
  await repo.raw.rm(abs, { force: true }).catch(() => {});
  if (entry.mode === 0o120000) await repo.raw.symlink(decoder.decode(bytes), abs);
  else {
    await repo.raw.writeFile(abs, bytes);
    if (entry.mode === 0o100755) await repo.raw.chmod(abs, 0o755).catch(() => {});
  }
}

async function restorePaths(repo, specs, { staged, worktree, source = null }) {
  if (!specs.length) throw fatal("you must specify path(s) to restore");
  const rel = specs.map(repo.spec);
  const head = await headOid(repo);
  if (staged) {
    const index = await indexMap(repo);
    const base = await treeMap(repo, source ? await resolveRev(repo, source) : head);
    const paths = [...new Set([...index.keys(), ...base.keys()])].filter((p) => matchesAny(p, rel));
    if (!paths.length) throw new GitExit(`error: pathspec '${specs[0]}' did not match any file(s) known to git`, 1);
    for (const filepath of paths) {
      if (base.has(filepath)) await git.resetIndex({ fs: repo.fs, dir: repo.dir, filepath, ...(source ? { ref: await resolveRev(repo, source) } : {}), cache: repo.cache });
      else await git.remove({ fs: repo.fs, dir: repo.dir, filepath, cache: repo.cache });
    }
  }
  if (worktree) {
    const from = source && !staged ? await treeMap(repo, await resolveRev(repo, source)) : await indexMap(repo);
    const paths = [...from.keys()].filter((p) => matchesAny(p, rel));
    if (!paths.length) throw new GitExit(`error: pathspec '${specs[0]}' did not match any file(s) known to git`, 1);
    for (const p of paths) await writeWork(repo, p, from.get(p));
    return paths.length;
  }
  return 0;
}

async function cmdRestore(repo, args) {
  let staged = false;
  let worktree = false;
  let source = null;
  const specs = [];
  for (const a of args) {
    if (a === "--staged" || a === "-S") staged = true;
    else if (a === "--worktree" || a === "-W") worktree = true;
    else if (a.startsWith("--source=")) source = a.slice(9);
    else if (a === "--") continue;
    else if (a.startsWith("-")) throw usageError(`unknown option \`${a.replace(/^-+/, "")}' (supported: --staged, --worktree, --source=<rev>)`);
    else specs.push(a);
  }
  if (!staged) worktree = true;
  await restorePaths(repo, specs, { staged, worktree, source });
  return result();
}

/** Clean enough to switch commits: nothing staged or modified in a tracked file. */
async function requireClean(repo, what) {
  const st = await computeStatus(repo);
  const dirty = st.entries.map((e) => e.path);
  if (dirty.length) {
    throw new GitExit(`error: Your local changes to the following files would be overwritten by ${what}:\n${dirty.map((p) => `\t${p}`).join("\n")}\nPlease commit your changes or stash them before you switch branches.\nAborting`, 1);
  }
}

async function switchTo(repo, ref, { create = false, startPoint = null } = {}) {
  const branches = await git.listBranches({ fs: repo.fs, dir: repo.dir });
  const head = await headOid(repo);
  if (create) {
    if (branches.includes(ref)) throw fatal(`a branch named '${ref}' already exists`);
    const target = startPoint ? await resolveRev(repo, startPoint) : head;
    if (target && target !== head) await requireClean(repo, "checkout");
    await git.branch({ fs: repo.fs, dir: repo.dir, ref, ...(target ? { object: target } : {}), checkout: false });
    if (target && target !== head) await git.checkout({ fs: repo.fs, dir: repo.dir, ref, force: true, cache: repo.cache });
    else await git.writeRef({ fs: repo.fs, dir: repo.dir, ref: "HEAD", value: `refs/heads/${ref}`, symbolic: true, force: true });
    return result("", `Switched to a new branch '${ref}'\n`);
  }
  if (!branches.includes(ref)) throw new GitExit(`error: pathspec '${ref}' did not match any file(s) known to git`, 1);
  if ((await currentBranch(repo)) === ref) return result("", `Already on '${ref}'\n`);
  const target = await git.resolveRef({ fs: repo.fs, dir: repo.dir, ref });
  if (target !== head) await requireClean(repo, "checkout");
  await git.checkout({ fs: repo.fs, dir: repo.dir, ref, force: target !== head, noCheckout: target === head, cache: repo.cache });
  return result("", `Switched to branch '${ref}'\n`);
}

async function cmdCheckout(repo, args) {
  const [left, paths] = splitDashDash(args);
  if (paths) {
    const source = left.find((a) => !a.startsWith("-")) ?? null;
    const n = await restorePaths(repo, paths, { staged: !!source, worktree: true, source });
    return result("", `Updated ${plural(n, "path", "paths")} from ${source ? `${source}` : "the index"}\n`);
  }
  if (left[0] === "-b" || left[0] === "-B") return switchTo(repo, left[1], { create: true, startPoint: left[2] ?? null });
  if (left.length === 1 && !left[0].startsWith("-")) {
    const branches = await git.listBranches({ fs: repo.fs, dir: repo.dir });
    if (branches.includes(left[0])) return switchTo(repo, left[0]);
    const index = await indexMap(repo);
    const spec = repo.spec(left[0]);
    if ([...index.keys()].some((p) => under(p, spec))) {
      const n = await restorePaths(repo, [left[0]], { staged: false, worktree: true });
      return result("", `Updated ${plural(n, "path", "paths")} from the index\n`);
    }
    throw new GitExit(`error: pathspec '${left[0]}' did not match any file(s) known to git`, 1);
  }
  throw unsupported(`checkout ${left.join(" ")}`.trim());
}

async function cmdSwitch(repo, args) {
  if (args[0] === "-c" || args[0] === "--create" || args[0] === "-C") return switchTo(repo, args[1], { create: true, startPoint: args[2] ?? null });
  if (args.length === 1 && !args[0].startsWith("-")) return switchTo(repo, args[0]);
  throw unsupported(`switch ${args.join(" ")}`.trim());
}

async function cmdReset(repo, args) {
  let mode = "mixed";
  let quiet = false;
  const [left, paths] = splitDashDash(args);
  const rest = [];
  for (const a of left) {
    if (a === "--soft" || a === "--mixed" || a === "--hard") mode = a.slice(2);
    else if (a === "-q" || a === "--quiet") quiet = true;
    else if (a.startsWith("-")) throw usageError(`unknown option \`${a.replace(/^-+/, "")}' (supported: --soft, --mixed, --hard, <rev>, -- <path>)`);
    else rest.push(a);
  }
  let rev = null;
  const specs = [...(paths ?? [])];
  for (const a of rest) {
    if (rev === null && paths === null && (await resolveRev(repo, a).then(() => true, () => false))) rev = a;
    else specs.push(a);
  }
  if (specs.length) {
    if (mode !== "mixed") throw fatal(`Cannot do ${mode} reset with paths.`);
    await restorePaths(repo, specs, { staged: true, worktree: false, source: rev });
    return result(quiet ? "" : await unstagedAfterReset(repo));
  }
  const head = await headOid(repo);
  const target = rev ? await resolveRev(repo, rev) : head;
  if (!target) throw fatal("ambiguous argument 'HEAD': unknown revision or path not in the working tree.");
  const branch = await currentBranch(repo);
  const before = await indexMap(repo);
  if (target !== head) await git.writeRef({ fs: repo.fs, dir: repo.dir, ref: branch ? `refs/heads/${branch}` : "HEAD", value: target, force: true });
  if (mode === "soft") return result();
  const tree = await treeMap(repo, target);
  for (const path of before.keys()) if (!tree.has(path)) await git.remove({ fs: repo.fs, dir: repo.dir, filepath: path, cache: repo.cache });
  for (const path of tree.keys()) {
    const i = before.get(path);
    if (!i || i.oid !== tree.get(path).oid || i.mode !== tree.get(path).mode) await git.resetIndex({ fs: repo.fs, dir: repo.dir, filepath: path, ref: target, cache: repo.cache });
  }
  if (mode === "mixed") return result(quiet ? "" : await unstagedAfterReset(repo));
  const work = await scanWorkdir(repo, tree);
  for (const path of before.keys()) if (!tree.has(path)) await repo.raw.rm(`${repo.dir}/${path}`, { force: true }).catch(() => {});
  for (const [path, entry] of tree) {
    const w = work.files.get(path);
    if (!w || (await workOid(repo, path, w)) !== entry.oid) await writeWork(repo, path, entry);
  }
  const { commit } = await git.readCommit({ fs: repo.fs, dir: repo.dir, oid: target, cache: repo.cache });
  return result(quiet ? "" : `HEAD is now at ${short(target)} ${subjectOf(commit.message)}\n`);
}

/** git's report after a mixed reset: what is now changed but not staged. */
async function unstagedAfterReset(repo) {
  const rows = (await computeStatus(repo)).entries.filter((e) => e.y !== " ");
  return rows.length ? `Unstaged changes after reset:\n${rows.map((e) => `${e.y}\t${e.path}`).join("\n")}\n` : "";
}

async function cmdBranch(repo, args) {
  const current = await currentBranch(repo);
  const head = await headOid(repo);
  if (args[0] === "--show-current") return result(current ? `${current}\n` : "");
  if (args[0] === "-d" || args[0] === "-D" || args[0] === "--delete") {
    const out = [];
    for (const ref of args.slice(1)) {
      if (ref === current) throw new GitExit(`error: cannot delete branch '${ref}' used by worktree at '${repo.dir}'`, 1);
      const oid = await git.resolveRef({ fs: repo.fs, dir: repo.dir, ref }).catch(() => null);
      if (!oid) throw new GitExit(`error: branch '${ref}' not found`, 1);
      await git.deleteBranch({ fs: repo.fs, dir: repo.dir, ref });
      out.push(`Deleted branch ${ref} (was ${short(oid)}).`);
    }
    return result(`${out.join("\n")}\n`);
  }
  if (args[0] === "-m" || args[0] === "-M" || args[0] === "--move") {
    const [oldref, ref] = args.length >= 3 ? [args[1], args[2]] : [current, args[1]];
    await git.renameBranch({ fs: repo.fs, dir: repo.dir, oldref, ref, checkout: oldref === current });
    return result();
  }
  const listing = args.every((a) => ["-a", "--all", "-r", "--remotes", "--list", "-l", "--no-color"].includes(a));
  if (listing) {
    const remotesOnly = args.includes("-r") || args.includes("--remotes");
    const all = args.includes("-a") || args.includes("--all");
    const lines = [];
    if (!remotesOnly) {
      if (!current && head) lines.push(`* (HEAD detached at ${short(head)})`);
      for (const b of (await git.listBranches({ fs: repo.fs, dir: repo.dir })).sort()) lines.push(`${b === current ? "*" : " "} ${b}`);
    }
    if (remotesOnly || all) {
      for (const r of await git.listRemotes({ fs: repo.fs, dir: repo.dir }).catch(() => [])) {
        for (const b of (await git.listBranches({ fs: repo.fs, dir: repo.dir, remote: r.remote }).catch(() => [])).sort()) {
          if (b === "HEAD") continue;
          lines.push(`  ${remotesOnly ? "" : "remotes/"}${r.remote}/${b}`);
        }
      }
    }
    return result(lines.length ? `${lines.join("\n")}\n` : "");
  }
  if (args.length <= 2 && !args[0].startsWith("-")) {
    const [ref, start] = args;
    const branches = await git.listBranches({ fs: repo.fs, dir: repo.dir });
    if (branches.includes(ref)) throw fatal(`a branch named '${ref}' already exists`);
    const object = start ? await resolveRev(repo, start) : head;
    if (!object) throw fatal(`not a valid object name: '${start ?? "HEAD"}'`);
    await git.branch({ fs: repo.fs, dir: repo.dir, ref, object, checkout: false });
    return result();
  }
  throw unsupported(`branch ${args.join(" ")}`);
}

async function cmdRevParse(repo, args) {
  const out = [];
  let shortNext = false;
  let abbrevRef = false;
  for (const a of args) {
    if (a === "--verify" || a === "-q" || a === "--quiet") continue;
    else if (a === "--short") shortNext = true;
    else if (/^--short=\d+$/.test(a)) shortNext = Number(a.split("=")[1]);
    else if (a === "--abbrev-ref") abbrevRef = true;
    else if (a === "--show-toplevel") out.push(repo.dir);
    else if (a === "--is-inside-work-tree") out.push("true");
    else if (a === "--is-inside-git-dir") out.push("false");
    else if (a === "--git-dir") out.push(repo.prefix ? `${repo.dir}/.git` : ".git");
    else if (a === "--show-prefix") out.push(repo.prefix ? `${repo.prefix}/` : "");
    else if (a === "--show-cdup") out.push(repo.prefix ? `${repo.prefix.split("/").map(() => "..").join("/")}/` : "");
    else if (a.startsWith("-")) throw usageError(`unknown option \`${a.replace(/^-+/, "")}'`);
    else if (abbrevRef) {
      if (a === "HEAD") out.push((await currentBranch(repo)) ?? "HEAD");
      else { await resolveRev(repo, a); out.push(a); }
    } else {
      const oid = await resolveRev(repo, a);
      out.push(shortNext ? oid.slice(0, typeof shortNext === "number" ? shortNext : 7) : oid);
    }
  }
  if (shortNext && !args.some((a) => !a.startsWith("-"))) out.push(short(await resolveRev(repo, "HEAD")));
  return result(out.length ? `${out.join("\n")}\n` : "");
}

async function cmdLsFiles(repo, args) {
  let others = false;
  let modified = false;
  const specs = [];
  for (const a of args) {
    if (a === "-o" || a === "--others") others = true;
    else if (a === "-m" || a === "--modified") modified = true;
    else if (a === "--exclude-standard" || a === "-c" || a === "--cached" || a === "--") continue;
    else if (a.startsWith("-")) throw usageError(`unknown option \`${a.replace(/^-+/, "")}'`);
    else specs.push(repo.spec(a));
  }
  const scope = specs.length ? specs : [repo.prefix];
  let paths;
  if (others) paths = (await computeStatus(repo)).untracked;
  else if (modified) paths = (await computeStatus(repo)).entries.filter((e) => e.y !== " ").map((e) => e.path);
  else paths = [...(await indexMap(repo)).keys()];
  return result(paths.filter((p) => matchesAny(p, scope)).sort().map((p) => `${repo.show(p)}\n`).join(""));
}

async function cmdConfig(repo, args) {
  const rest = args.filter((a) => !["--global", "--local", "--system", "--add", "--replace-all"].includes(a));
  if (rest[0] === "--list" || rest[0] === "-l") {
    const text = await repo.raw.readFile(`${repo.dir}/.git/config`, "utf8").catch(() => "");
    const lines = [];
    let section = "";
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      const head = /^\[([^\s\]]+)(?:\s+"([^"]*)")?\]$/.exec(line);
      if (head) { section = head[2] !== undefined ? `${head[1].toLowerCase()}.${head[2]}` : head[1].toLowerCase(); continue; }
      const kv = /^([A-Za-z0-9-]+)\s*=\s*(.*)$/.exec(line);
      if (kv && section) lines.push(`${section}.${kv[1].toLowerCase()}=${kv[2]}`);
    }
    return result(lines.length ? `${lines.join("\n")}\n` : "");
  }
  if (rest[0] === "--unset") {
    await git.setConfig({ fs: repo.fs, dir: repo.dir, path: rest[1], value: undefined });
    return result();
  }
  const get = rest[0] === "--get";
  const [key, value] = get ? [rest[1], undefined] : rest;
  if (!key || key.startsWith("-")) throw usageError("usage: git config [--get|--unset|--list] <key> [<value>]");
  if (value === undefined) {
    const v = repo.overrides[key] ?? (await git.getConfig({ fs: repo.fs, dir: repo.dir, path: key }).catch(() => undefined));
    return v === undefined ? result("", "", 1) : result(`${v}\n`);
  }
  await git.setConfig({ fs: repo.fs, dir: repo.dir, path: key, value });
  return result();
}

async function cmdRemote(repo, args) {
  const remotes = await git.listRemotes({ fs: repo.fs, dir: repo.dir }).catch(() => []);
  // A credential in a remote URL is never printed.
  const clean = (url) => String(url).replace(/^(\w+:\/\/)[^@/]*@/, "$1");
  if (!args.length) return result(remotes.map((r) => `${r.remote}\n`).join(""));
  if (args[0] === "-v" || args[0] === "--verbose") return result(remotes.map((r) => `${r.remote}\t${clean(r.url)} (fetch)\n${r.remote}\t${clean(r.url)} (push)\n`).join(""));
  if (args[0] === "get-url") {
    const r = remotes.find((x) => x.remote === args[1]);
    if (!r) throw new GitExit(`error: No such remote '${args[1]}'`, 2);
    return result(`${clean(r.url)}\n`);
  }
  throw new GitExit(`git remote ${args[0]}: not available in a cell. Kortix manages this session's remote and pushes its branch (POST /kortix/git/commit-push).`, 1);
}

async function cmdInit(raw, cwd, args) {
  let branch = "main";
  let target = cwd;
  let quiet = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-b" || args[i] === "--initial-branch") branch = args[++i];
    else if (args[i].startsWith("--initial-branch=")) branch = args[i].split("=")[1];
    else if (args[i] === "-q" || args[i] === "--quiet") quiet = true;
    else if (args[i].startsWith("-")) throw usageError(`unknown option \`${args[i].replace(/^-+/, "")}'`);
    else target = absolute(cwd, args[i]);
  }
  const fs = gitFs(raw);
  const existed = await raw.exists(`${target}/.git/HEAD`).catch(() => false);
  await raw.mkdir(target, { recursive: true });
  if (!existed) await git.init({ fs, dir: target, defaultBranch: branch });
  return result(quiet ? "" : `${existed ? "Reinitialized existing" : "Initialized empty"} Git repository in ${target}/.git/\n`);
}

// ── the command ──────────────────────────────────────────────────────────

const HANDLERS = {
  status: cmdStatus, diff: cmdDiff, log: cmdLog, show: cmdShow, add: cmdAdd, rm: cmdRm, commit: cmdCommit,
  restore: cmdRestore, checkout: cmdCheckout, switch: cmdSwitch, reset: cmdReset, branch: cmdBranch,
  "rev-parse": cmdRevParse, "ls-files": cmdLsFiles, config: cmdConfig, remote: cmdRemote,
};

/**
 * Run `git <args>` over a just-bash command context (`fs`, `cwd`, `env`).
 * Never throws: every failure is git-shaped output and an exit code.
 */
export async function runGit(args, ctx) {
  try {
    let cwd = ctx.cwd || "/";
    const overrides = {};
    let i = 0;
    for (; i < args.length; i++) {
      const a = args[i];
      if (a === "-C") cwd = absolute(cwd, args[++i]);
      else if (a === "-c") {
        const [k, ...v] = String(args[++i]).split("=");
        overrides[k.toLowerCase()] = v.join("=");
      } else if (a === "--no-pager" || a === "-P" || a === "--no-optional-locks" || a === "--paginate" || a === "-p") continue;
      else break;
    }
    const sub = args[i];
    const rest = args.slice(i + 1);
    if (sub === undefined || sub === "help" || sub === "-h" || sub === "--help") {
      return result("", `usage: git [-C <path>] [-c <name>=<value>] <command> [<args>]\n\nThis cell's git runs locally over isomorphic-git. Commands: ${GIT_SUBCOMMANDS.join(", ")}.\nKortix pushes the session's branch itself; there is no push, pull, fetch or clone.\n`, sub === undefined ? 1 : 0);
    }
    if (sub === "--version" || sub === "version") return result(`git version 2.43.0 (pi cell, isomorphic-git ${git.version()})\n`);
    if (NETWORK.has(sub)) {
      return result("", `git ${sub}: not available in a cell. Kortix pushes this session's commits to its branch (POST /kortix/git/commit-push); commit them here with \`git commit\`.\n`, 1);
    }
    const env = (k) => (typeof ctx.env?.get === "function" ? ctx.env.get(k) : ctx.env?.[k]) || undefined;
    if (sub === "init") return await cmdInit(ctx.fs, cwd, rest);
    const handler = HANDLERS[sub];
    if (!handler) throw unsupported(`'${sub}'`);
    const repo = await openRepo(ctx.fs, cwd, env, overrides);
    // just-bash hands stdin as a byte string (one char per byte).
    repo.stdin = typeof ctx.stdin === "string" ? decoder.decode(Uint8Array.from(ctx.stdin, (c) => c.charCodeAt(0) & 0xff)) : "";
    return await handler(repo, rest);
  } catch (e) {
    if (e instanceof GitExit) return e.result;
    return result("", `fatal: ${String(e?.message ?? e)}\n`, 128);
  }
}

/** The `git` command for just-bash (registered in execenv.cell.js). */
export function gitCommand(defineCommand) {
  return defineCommand("git", (args, ctx) => runGit(args, ctx));
}
