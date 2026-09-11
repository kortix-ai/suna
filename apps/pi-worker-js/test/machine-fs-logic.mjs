// THE MACHINE AS A FILESYSTEM AND A REPOSITORY — the adapter the file routes
// and the git routes run over once a session has attached its environment.
//
// What must hold: the eight fs methods answer in the shape cell-files.js reads
// (dirents as booleans, stat with isDirectory/size, errors with a code); the
// two walks are ONE command each rather than one round trip per directory;
// porcelain and numstat parse into the panel's rows; commit-push says
// "nothing to do" on a clean tree, commits and pushes on a dirty one, and
// reports a failed push as a failure with the output rather than a success.
// EXPECTED_PASSES=25
import { watchClaims } from "../../tools/crash-reporter.mjs";
let bad = 0;
const check = watchClaims((n, c, d = "") => { if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });
const { machineFs, machineGit, parsePorcelain, parseNumstat } = await import("../src/machine-fs.js");

const ok = (value) => ({ ok: true, value });
const err = (message, code = "unknown") => ({ ok: false, error: { code, message } });

/** A fake machine: files in a map, commands answered by a script. */
function fakeMachine({ files = {}, dirs = ["/workspace"], commands = {} } = {}) {
  const execs = [];
  const answer = (command) => {
    for (const [pattern, out] of Object.entries(commands)) {
      if (command.includes(pattern)) return typeof out === "function" ? out(command) : out;
    }
    return { stdout: "", stderr: `no fake for: ${command}`, exitCode: 127 };
  };
  return {
    files, dirs, execs,
    exec: async (command, options) => { execs.push({ command, options }); const a = answer(command); return ok({ stdout: a.stdout ?? "", stderr: a.stderr ?? "", exitCode: a.exitCode ?? 0 }); },
    exists: async (p) => ok(p in files || dirs.includes(p)),
    fileInfo: async (p) => (p in files ? ok({ name: p.split("/").pop(), path: p, kind: "file", size: files[p].length, mtimeMs: 1 }) : dirs.includes(p) ? ok({ name: p.split("/").pop(), path: p, kind: "directory", size: 0, mtimeMs: 1 }) : err("ENOENT", "ENOENT")),
    listDir: async (p) => (dirs.includes(p) ? ok([
      ...dirs.filter((d) => d !== p && d.startsWith(`${p}/`) && !d.slice(p.length + 1).includes("/")).map((d) => ({ name: d.split("/").pop(), path: d, kind: "directory", size: 0 })),
      ...Object.keys(files).filter((f) => f.startsWith(`${p}/`) && !f.slice(p.length + 1).includes("/")).map((f) => ({ name: f.split("/").pop(), path: f, kind: "file", size: files[f].length })),
    ]) : err("ENOENT", "ENOENT")),
    readBinaryFile: async (p) => (p in files ? ok(new TextEncoder().encode(files[p])) : err("no such file", "ENOENT")),
    writeFile: async (p, c) => { files[p] = typeof c === "string" ? c : new TextDecoder().decode(c); return ok(undefined); },
    createDir: async (p) => { dirs.push(p); return ok(undefined); },
    remove: async (p) => { delete files[p]; return ok(undefined); },
    renameFile: async (a, b) => { files[b] = files[a]; delete files[a]; return ok(undefined); },
  };
}

// ── the fs surface, in the shape the routes read ──
{
  const m = fakeMachine({ files: { "/workspace/README.md": "# hi\n", "/workspace/src/a.js": "a" }, dirs: ["/workspace", "/workspace/src"] });
  const fs = machineFs(m);
  check("the adapter names itself so a route can tell which tree it holds", fs.kind === "machine", "");
  check("exists answers a boolean for a file, a directory and nothing",
    (await fs.exists("README.md")) === true && (await fs.exists("/workspace/src")) === true && (await fs.exists("nope")) === false, "");
  const st = await fs.stat("src");
  check("stat answers isDirectory/isFile as BOOLEANS and a size — what cell-files reads", st.isDirectory === true && st.isFile === false && typeof st.size === "number", JSON.stringify(st));
  const missing = await fs.stat("nope").catch((e) => e);
  check("a missing path throws with a code, as the in-memory tree does", missing instanceof Error && missing.code === "ENOENT", String(missing?.code));
  const ents = await fs.readdirWithFileTypes("/workspace");
  check("readdirWithFileTypes answers dirents with boolean kinds, files and directories both",
    ents.some((e) => e.name === "src" && e.isDirectory) && ents.some((e) => e.name === "README.md" && e.isFile), JSON.stringify(ents));
  check("a relative path is resolved under /workspace — the panel sends both forms",
    new TextDecoder().decode(await fs.readFileBuffer("README.md")) === "# hi\n" && new TextDecoder().decode(await fs.readFileBuffer("/workspace/README.md")) === "# hi\n", "");
  await fs.writeFile("new.txt", "n");
  await fs.mkdir("lib");
  await fs.mv("new.txt", "moved.txt");
  check("write, mkdir and mv reach the machine by absolute path",
    m.files["/workspace/moved.txt"] === "n" && !("/workspace/new.txt" in m.files) && m.dirs.includes("/workspace/lib"), JSON.stringify(Object.keys(m.files)));
  await fs.rm("moved.txt");
  check("rm removes it", !("/workspace/moved.txt" in m.files), "");
}

// ── the two walks are one command each ──
{
  const rgJson = [
    JSON.stringify({ type: "begin", data: { path: { text: "src/a.js" } } }),
    JSON.stringify({ type: "match", data: { path: { text: "src/a.js" }, lines: { text: "const x = needle;\n" }, line_number: 3, absolute_offset: 40, submatches: [{ match: { text: "needle" }, start: 10, end: 16 }] } }),
    JSON.stringify({ type: "end", data: {} }),
    "not json",
  ].join("\n");
  const m = fakeMachine({ commands: { "rg --files": { stdout: "./README.md\nsrc/a.js\n\n" }, "rg --json": { stdout: rgJson } } });
  const fs = machineFs(m);
  const all = await fs.listAll();
  check("listAll is ONE ripgrep, relative paths, the leading ./ dropped and blanks removed",
    JSON.stringify(all) === JSON.stringify(["README.md", "src/a.js"]) && m.execs.length === 1 && /rg --files/.test(m.execs[0].command), JSON.stringify(all));
  check("and it excludes .git, node_modules and build output the way the daemon's find does",
    /-g '!\.git'/.test(m.execs[0].command) && /node_modules/.test(m.execs[0].command), m.execs[0].command);
  const found = await fs.search("needle");
  check("search is ONE ripgrep --json, reduced to the route's match shape: path, lines, line_number, submatches",
    found.length === 1 && found[0].path === "./src/a.js" && found[0].line_number === 3 && found[0].submatches[0].match === "needle" && found[0].submatches[0].start === 10, JSON.stringify(found));
  check("a pattern is shell-quoted, so a quote in it cannot escape the command",
    (await fs.search("it's"), /-e 'it'\\''s'/.test(m.execs.at(-1).command)), m.execs.at(-1).command);
}

// ── git: the parsers ──
check("porcelain v1 -z parses untracked, added, modified and deleted into the panel's statuses",
  JSON.stringify(parsePorcelain("?? new.txt\0A  staged.txt\0 M edited.txt\0D  gone.txt\0").map((r) => `${r.path}:${r.status}`))
    === JSON.stringify(["new.txt:added", "staged.txt:added", "edited.txt:modified", "gone.txt:deleted"]), JSON.stringify(parsePorcelain("?? new.txt\0A  staged.txt\0 M edited.txt\0D  gone.txt\0")));
check("an empty status is an empty list, not a row of nothing", parsePorcelain("").length === 0 && parsePorcelain(null).length === 0, "");
check("numstat parses additions and deletions per path, and a binary's dashes as zero",
  JSON.stringify(parseNumstat("3\t1\tsrc/a.js\n-\t-\timg.png\n")) === JSON.stringify({ "src/a.js": { additions: 3, deletions: 1 }, "img.png": { additions: 0, deletions: 0 } }), JSON.stringify(parseNumstat("3\t1\tsrc/a.js\n-\t-\timg.png\n")));

// ── git: status, diffs, commit-push over the machine ──
{
  const m = fakeMachine({ commands: {
    "git status --porcelain": { stdout: " M src/a.js\0?? new.txt\0" },
    "git diff --numstat": { stdout: "2\t1\tsrc/a.js\n" },
    "git diff --no-index": { stdout: "--- /dev/null\n+++ new.txt\n@@ -0,0 +1 @@\n+n\n" },
    "git diff --no-color HEAD": { stdout: "--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-x\n+y\n" },
  } });
  const g = machineGit(m);
  const st = await g.status();
  check("status carries the parsed rows WITH line counts from numstat",
    st.length === 2 && st[0].path === "src/a.js" && st[0].status === "modified" && st[0].added === 2 && st[0].removed === 1 && st[1].status === "added", JSON.stringify(st));
  const diffs = await g.fileDiffs();
  check("fileDiffs is OpenCode's SnapshotFileDiff: one entry per file with its own patch, additions, deletions, status",
    diffs.length === 2 && diffs[0].file === "src/a.js" && /\+y/.test(diffs[0].patch) && diffs[0].additions === 2 && diffs[1].file === "new.txt" && /\+n/.test(diffs[1].patch) && diffs[1].status === "added", JSON.stringify(diffs).slice(0, 200));
}
{
  const m = fakeMachine({ commands: { "git status --porcelain": { stdout: "" }, "git rev-parse HEAD": { stdout: "abc123\n" } } });
  const r = await machineGit(m).commitAndPush({ branch: "s1" });
  check("commit-push on a clean tree is `nothing to do` with the head, and runs no commit", r.ok && r.nothingToDo === true && r.committed === false && r.headSha === "abc123" && !m.execs.some((e) => /git add/.test(e.command)), JSON.stringify(r));
}
{
  const m = fakeMachine({ commands: {
    "git status --porcelain": { stdout: " M a\0" },
    "git add -A": { stdout: "def456\n" },
    "git push origin HEAD:refs/heads/s1": { stdout: "To origin\n * [new branch]", exitCode: 0 },
  } });
  const r = await machineGit(m).commitAndPush({ branch: "s1", message: "it's done" });
  check("on a dirty tree it stages everything, commits with the message, and pushes HEAD to the session branch",
    r.ok && r.committed && r.pushed && r.headSha === "def456" && r.branch === "s1" && m.execs.some((e) => /git add -A/.test(e.command) && /'it'\\''s done'/.test(e.command)), JSON.stringify(r));
  check("the push names refs/heads/<branch> explicitly — the proxy authorizes exactly that ref", m.execs.some((e) => /git push origin HEAD:refs\/heads\/s1/.test(e.command)), "");
}
{
  const m = fakeMachine({ commands: { "git status --porcelain": { stdout: " M a\0" }, "git add -A": { stdout: "def456\n" }, "git push": { stdout: "", stderr: "remote: forbidden", exitCode: 128 } } });
  const r = await machineGit(m).commitAndPush({ branch: "s1" });
  check("a push the origin refuses is reported as a FAILURE with the output, never as success", r.ok === false && r.status === 502 && /forbidden/.test(r.error) && r.headSha === "def456", JSON.stringify(r));
}
{
  const m = fakeMachine({ commands: { "git status --porcelain": { stdout: " M a\0" }, "git add -A": { stdout: "", stderr: "nothing to commit", exitCode: 1 } } });
  const r = await machineGit(m).commitAndPush({ branch: "s1" });
  check("a commit that fails is a failure too, and nothing is pushed", r.ok === false && /commit failed/.test(r.error) && !m.execs.some((e) => /git push/.test(e.command)), JSON.stringify(r));
}
{
  const m = fakeMachine({ commands: { "git fetch -q origin s1 && git merge --ff-only": { stdout: "Fast-forward\n" } } });
  const r = await machineGit(m).pull("s1");
  check("pull is a fetch of the branch and a fast-forward only merge — never a merge commit on the machine", r.ok && /Fast-forward/.test(r.output) && /--ff-only/.test(m.execs[0].command), JSON.stringify(r));
  const m2 = fakeMachine({ commands: { "git fetch": { stdout: "", stderr: "fatal: not possible to fast-forward", exitCode: 128 } } });
  check("and a pull that cannot fast-forward says so instead of pretending", (await machineGit(m2).pull("s1")).ok === false, "");
}
{
  // An exec the machine cannot run at all (the box is gone) surfaces as a throw
  // the route catches, not as an empty status that reads as "clean".
  const dead = { exec: async () => err("fetch failed: ECONNREFUSED") };
  const e = await machineGit(dead).status().catch((x) => x);
  check("a machine that cannot run git throws, so a route never reports a dead box as a clean tree", e instanceof Error && /ECONNREFUSED/.test(e.message), String(e?.message));
}

console.log(bad ? `\n${bad} FAILED` : "\nall claims hold");
process.exit(bad ? 1 : 0);
