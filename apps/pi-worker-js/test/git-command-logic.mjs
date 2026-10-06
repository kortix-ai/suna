// `git` IN THE CELL'S SHELL. The checkout is a real repository, but the shell
// had no `git`: `git status` answered "command not found". These claims run the
// command the way the agent's bash tool does — through the cell's
// ExecutionEnv over just-bash — on a repository the command itself creates,
// and read back what a model and a simple parser read: exit codes, porcelain
// letters, patch text, log lines.
// EXPECTED_PASSES=59
import { DatabaseSync } from "node:sqlite";
import { watchClaims } from "../../tools/crash-reporter.mjs";
import { installWorkerGlobals } from "./cell-harness.mjs";
installWorkerGlobals();
let bad = 0, claims = 0;
const check = watchClaims((n, c, d = "") => { claims++; if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });
const { cellFs, cellExecutionEnv, CELL_COMMANDS, CELL_MISSING } = await import("../src/execenv.cell.js");

const makeSql = (db) => ({ exec(q, ...a) { const t = q.trim(); if (/^(CREATE|INSERT|UPDATE|DELETE)/i.test(t)) { const st = db.prepare(t); a.length ? st.run(...a) : st.run(); return { toArray: () => [], [Symbol.iterator]: function* () {} }; } const rows = db.prepare(t).all(...a); return { toArray: () => rows, [Symbol.iterator]: function* () { yield* rows; } }; } });
const db = new DatabaseSync(":memory:");
const cell = cellFs(makeSql(db));
await cell.ready;
const env = cellExecutionEnv(cell);
/** One shell line, as the bash tool runs it: `{exitCode, stdout, stderr}`. */
async function sh(cmd, cwd) {
  const r = await env.exec(cmd, cwd ? { cwd } : {});
  if (!r.ok) throw new Error(`${cmd}: ${r.error?.message}`);
  return r.value;
}
const porcelain = async (cwd) => (await sh("git status --porcelain", cwd)).stdout;

// ── the command exists, and says what it is ──
check("git is a command in the shell and in the list the model is told about",
  CELL_COMMANDS.includes("git") && !CELL_MISSING.includes("git") && (await sh("command -v git")).stdout.trim() === "/usr/bin/git", "");
{
  const r = await sh("git --version");
  check("`git --version` answers, naming isomorphic-git", r.exitCode === 0 && /^git version \d+\.\d+\.\d+ .*isomorphic-git/.test(r.stdout), JSON.stringify(r));
}
{
  const r = await sh("git status", "/tmp");
  check("outside a repository it is git's own fatal, exit 128",
    r.exitCode === 128 && r.stderr === "fatal: not a git repository (or any of the parent directories): .git\n", JSON.stringify(r));
}

// ── init, untracked, ignore ──
{
  const r = await sh("git init");
  check("`git init` makes the repository and says where", r.exitCode === 0 && r.stdout === "Initialized empty Git repository in /workspace/.git/\n", JSON.stringify(r));
}
await sh("printf 'hello\\n' > a.txt && mkdir -p src node_modules/dep && printf 'export const b = 1;\\n' > src/b.ts && printf 'x' > node_modules/dep/index.js && printf 'log' > debug.log && printf 'node_modules/\\n*.log\\n' > .gitignore");
{
  const r = await sh("git status");
  check("an unborn branch's long status says so and lists what is untracked",
    r.exitCode === 0 && r.stdout.startsWith("On branch main\n\nNo commits yet\n") && r.stdout.includes("Untracked files:\n") && r.stdout.includes("\ta.txt\n") && r.stdout.includes("\tsrc/\n"),
    JSON.stringify(r.stdout));
}
{
  const p = await porcelain();
  check("porcelain is `?? path`, a wholly untracked directory as one `dir/`",
    p === "?? .gitignore\n?? a.txt\n?? src/\n", JSON.stringify(p));
  check("and nothing .gitignore excludes: not node_modules/, not *.log", !p.includes("node_modules") && !p.includes("debug.log"), JSON.stringify(p));
  const all = (await sh("git status --porcelain -uall")).stdout;
  check("`-uall` lists the files inside an untracked directory", all.includes("?? src/b.ts\n") && !all.includes("?? src/\n"), JSON.stringify(all));
}

// ── add and commit ──
{
  const r = await sh("git add nope");
  check("a pathspec that matches nothing is git's fatal, exit 128",
    r.exitCode === 128 && r.stderr === "fatal: pathspec 'nope' did not match any files\n", JSON.stringify(r));
}
{
  const r = await sh("git add .");
  check("`git add .` stages every untracked file and skips the ignored ones",
    r.exitCode === 0 && (await porcelain()) === "A  .gitignore\nA  a.txt\nA  src/b.ts\n", JSON.stringify(await porcelain()));
}
{
  const r = await sh("git add debug.log");
  check("adding an ignored file by name is refused with git's hint, exit 1",
    r.exitCode === 1 && r.stderr.startsWith("The following paths are ignored by one of your .gitignore files:\ndebug.log\n") && r.stderr.includes("Use -f"), JSON.stringify(r));
  const f = await sh("git add -f debug.log");
  check("and `-f` adds it", f.exitCode === 0 && (await porcelain()).includes("A  debug.log\n"), JSON.stringify(await porcelain()));
  const rm = await sh("git rm --cached debug.log");
  check("`git rm --cached` takes it out of the index and leaves the file", rm.exitCode === 0 && rm.stdout === "rm 'debug.log'\n" && !(await porcelain()).includes("debug.log") && (await sh("cat debug.log")).stdout === "log", JSON.stringify(rm));
}
{
  const r = await sh("git diff --cached -- a.txt");
  check("`git diff --cached` shows a new file as git does: mode, /dev/null, @@ -0,0 +1 @@",
    r.stdout.includes("diff --git a/a.txt b/a.txt\nnew file mode 100644\nindex 0000000..") && r.stdout.includes("--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+hello\n"), JSON.stringify(r.stdout));
}
{
  const r = await sh("git commit");
  check("`git commit` with no message aborts, exit 1, and names -m (there is no editor)", r.exitCode === 1 && /empty commit message/.test(r.stderr) && /-m/.test(r.stderr), JSON.stringify(r));
}
let first;
{
  const r = await sh('git commit -m "first commit"');
  first = /\[main \(root-commit\) ([0-9a-f]{7})\]/.exec(r.stdout)?.[1];
  check("`git commit -m` prints git's summary: branch, root-commit, short sha, subject, counts, create modes",
    r.exitCode === 0 && /^\[main \(root-commit\) [0-9a-f]{7}\] first commit\n 3 files changed, 4 insertions\(\+\)\n create mode 100644 \.gitignore\n create mode 100644 a\.txt\n create mode 100644 src\/b\.ts\n$/.test(r.stdout),
    JSON.stringify(r.stdout));
}
check("a clean tree says so, in git's exact words", (await sh("git status")).stdout === "On branch main\nnothing to commit, working tree clean\n", JSON.stringify((await sh("git status")).stdout));
{
  const r = await sh("git commit -m again");
  check("committing nothing is exit 1 with the status explaining why", r.exitCode === 1 && r.stdout.includes("nothing to commit"), JSON.stringify(r));
}

// ── THE STAT TRAP: same size, same second ──
// The tree writes in milliseconds, and git's index caches stat data at one
// second: a same-length edit right after a commit would read as unchanged.
await sh("printf 'HELLO\\n' > a.txt");
check("an edit of the same length in the same second as the commit is seen (object ids, not stat)",
  (await porcelain()) === " M a.txt\n", JSON.stringify(await porcelain()));

// ── diff ──
{
  const r = await sh("git diff");
  check("`git diff` is a real unified diff: header, index line with mode, one-line hunk",
    r.exitCode === 0 && /^diff --git a\/a\.txt b\/a\.txt\nindex [0-9a-f]{7}\.\.[0-9a-f]{7} 100644\n--- a\/a\.txt\n\+\+\+ b\/a\.txt\n@@ -1 \+1 @@\n-hello\n\+HELLO\n$/.test(r.stdout),
    JSON.stringify(r.stdout));
  const st = await sh("git diff --stat");
  check("`git diff --stat` prints the bar and git's summary", st.stdout === " a.txt | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n", JSON.stringify(st.stdout));
  const ns = await sh("git diff --name-status");
  check("`--name-status` and `--name-only` and `--numstat` answer in git's shapes",
    ns.stdout === "M\ta.txt\n" && (await sh("git diff --name-only")).stdout === "a.txt\n" && (await sh("git diff --numstat")).stdout === "1\t1\ta.txt\n", JSON.stringify(ns.stdout));
  check("an unchanged path filters the diff to nothing", (await sh("git diff -- src")).stdout === "", "");
}
{
  await sh("git add a.txt");
  check("after `git add` the change is staged: `M  a.txt`, `git diff` empty, `git diff --staged` has it",
    (await porcelain()) === "M  a.txt\n" && (await sh("git diff")).stdout === "" && (await sh("git diff --staged")).stdout.includes("+HELLO"), JSON.stringify(await porcelain()));
  const long = (await sh("git status")).stdout;
  check("the long status lists it under Changes to be committed",
    long.includes('Changes to be committed:\n  (use "git restore --staged <file>..." to unstage)\n\tmodified:   a.txt\n'), JSON.stringify(long));
  await sh("git restore --staged a.txt");
  check("`git restore --staged` unstages it back to ` M`", (await porcelain()) === " M a.txt\n", JSON.stringify(await porcelain()));
  const r = await sh("git restore a.txt");
  check("`git restore` puts back the index's copy", r.exitCode === 0 && (await sh("cat a.txt")).stdout === "hello\n" && (await porcelain()) === "", JSON.stringify(await porcelain()));
  await sh("printf 'scratch\\n' > a.txt");
  const c = await sh("git checkout -- a.txt");
  check("`git checkout -- path` does the same", c.exitCode === 0 && (await sh("cat a.txt")).stdout === "hello\n" && /Updated 1 path from the index/.test(c.stderr), JSON.stringify(c));
}
{
  await sh("printf '\\x00\\x01\\x02' > blob.bin && git add blob.bin");
  check("a binary file is `Binary files … differ`, not bytes", (await sh("git diff --cached")).stdout.includes("Binary files /dev/null and b/blob.bin differ\n"), "");
  await sh("git rm --cached -q blob.bin && rm blob.bin");
}

// ── more commits, log, show, rev-parse ──
await sh("printf 'hello\\nworld\\n' > a.txt && rm src/b.ts");
check("a deleted tracked file is ` D`", (await porcelain()) === " M a.txt\n D src/b.ts\n", JSON.stringify(await porcelain()));
{
  const r = await sh('git commit -am "second: a grows, b goes"');
  check("`git commit -am` stages tracked edits and deletions and commits them",
    r.exitCode === 0 && /^\[main [0-9a-f]{7}\] second: a grows, b goes\n 2 files changed, 1 insertion\(\+\), 1 deletion\(-\)\n delete mode 100644 src\/b\.ts\n$/.test(r.stdout) && (await porcelain()) === "",
    JSON.stringify(r.stdout));
}
{
  const r = await sh("git log --oneline");
  check("`git log --oneline` is one `sha7 subject` line per commit, newest first, undecorated as when piped",
    /^[0-9a-f]{7} second: a grows, b goes\n[0-9a-f]{7} first commit\n$/.test(r.stdout) && r.stdout.endsWith(`${first} first commit\n`), JSON.stringify(r.stdout));
  const m = await sh("git log -1");
  check("`git log -1` is git's medium format: commit, Author, Date, indented message",
    /^commit [0-9a-f]{40}\nAuthor: Kortix <agent@kortix\.ai>\nDate:   (Sun|Mon|Tue|Wed|Thu|Fri|Sat) [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4} [+-]\d{4}\n\n    second: a grows, b goes\n$/.test(m.stdout),
    JSON.stringify(m.stdout));
  const h = (await sh("git rev-parse HEAD")).stdout.trim();
  check("`--format=%H` and `git rev-parse HEAD` agree on the full sha",
    /^[0-9a-f]{40}$/.test(h) && (await sh("git log -n 1 --format=%H")).stdout.trim() === h && (await sh("git rev-parse --short HEAD")).stdout.trim() === h.slice(0, 7), h);
  check("`--format` takes git's placeholders", (await sh('git log -1 --format="%h|%an|%s"')).stdout === `${h.slice(0, 7)}|Kortix|second: a grows, b goes\n`, (await sh('git log -1 --format="%h|%an|%s"')).stdout);
  check("`git rev-parse --abbrev-ref HEAD` is the branch, `--show-toplevel` the root",
    (await sh("git rev-parse --abbrev-ref HEAD")).stdout === "main\n" && (await sh("git rev-parse --show-toplevel")).stdout === "/workspace\n", "");
  check("`HEAD~1` resolves to the first commit", (await sh("git rev-parse --short HEAD~1")).stdout.trim() === first, (await sh("git rev-parse --short HEAD~1")).stdout);
  const show = await sh("git show --stat HEAD");
  check("`git show --stat` prints the commit, a blank line, and its stat against the parent",
    show.stdout.endsWith("\n    second: a grows, b goes\n\n a.txt    | 1 +\n src/b.ts | 1 -\n 2 files changed, 1 insertion(+), 1 deletion(-)\n") && show.stdout.startsWith("commit "),
    JSON.stringify(show.stdout));
  check("`git show HEAD~1:src/b.ts` prints a file as it was", (await sh("git show HEAD~1:src/b.ts")).stdout === "export const b = 1;\n", "");
  check("`git ls-files` lists the index", (await sh("git ls-files")).stdout === ".gitignore\na.txt\n", (await sh("git ls-files")).stdout);
}

// ── who commits ──
{
  await sh("git config user.name Bo && git config user.email bo@example.com");
  check("`git config` reads back what it set", (await sh("git config user.name")).stdout === "Bo\n" && (await sh("git config --get user.email")).stdout === "bo@example.com\n", "");
  await sh('git commit --allow-empty -m "by config"');
  check("the configured identity authors the next commit", (await sh('git log -1 --format="%an <%ae>"')).stdout === "Bo <bo@example.com>\n", (await sh('git log -1 --format="%an <%ae>"')).stdout);
  await sh('GIT_AUTHOR_NAME=Ada GIT_AUTHOR_EMAIL=ada@example.com git commit --allow-empty -m "by env"');
  check("GIT_AUTHOR_* in the environment wins over config, as in git", (await sh('git log -1 --format="%an <%ae>"')).stdout === "Ada <ada@example.com>\n", (await sh('git log -1 --format="%an <%ae>"')).stdout);
  await sh('git commit --amend -m "by env, amended"');
  check("`--amend` replaces the last commit rather than adding one",
    (await sh("git log -1 --format=%s")).stdout === "by env, amended\n" && (await sh("git log --oneline")).stdout.trim().split("\n").length === 4, (await sh("git log --oneline")).stdout);
}

// ── branches ──
{
  check("`git branch` marks the current one", (await sh("git branch")).stdout === "* main\n", (await sh("git branch")).stdout);
  const c = await sh("git checkout -b topic");
  check("`git checkout -b` creates and switches, reporting on stderr as git does",
    c.exitCode === 0 && c.stderr === "Switched to a new branch 'topic'\n" && (await sh("git branch --show-current")).stdout === "topic\n", JSON.stringify(c));
  await sh("printf 'topic\\n' > t.txt && git add t.txt && git commit -q -m topic");
  const s = await sh("git switch main");
  check("`git switch` to a branch at another commit updates the tree", s.exitCode === 0 && (await sh("test -e t.txt; echo $?")).stdout === "1\n", JSON.stringify(s));
  await sh("printf 'dirty\\n' > a.txt");
  const refused = await sh("git checkout topic");
  check("switching over uncommitted changes is refused, exit 1, and nothing moves",
    refused.exitCode === 1 && /would be overwritten/.test(refused.stderr) && (await sh("git branch --show-current")).stdout === "main\n" && (await sh("cat a.txt")).stdout === "dirty\n", JSON.stringify(refused));
  await sh("git restore a.txt");
  check("`git branch` lists both, sorted, current marked", (await sh("git branch")).stdout === "* main\n  topic\n", (await sh("git branch")).stdout);
  check("`git branch -D` deletes another branch", (await sh("git branch -D topic")).stdout.startsWith("Deleted branch topic (was ") && (await sh("git branch")).stdout === "* main\n", "");
}

// ── reset ──
{
  await sh("printf 'staged\\n' > s.txt && git add s.txt");
  const r = await sh("git reset");
  check("`git reset` unstages everything and keeps the files", r.exitCode === 0 && (await porcelain()) === "?? s.txt\n", JSON.stringify(await porcelain()));
  await sh("rm s.txt");
  const before = (await sh("git rev-parse HEAD~1")).stdout.trim();
  const h = await sh("git reset --hard HEAD~1");
  check("`git reset --hard HEAD~1` moves the branch and says where HEAD is now",
    h.exitCode === 0 && h.stdout.startsWith(`HEAD is now at ${before.slice(0, 7)} `) && (await sh("git rev-parse HEAD")).stdout.trim() === before, JSON.stringify(h));
}

// ── from a subdirectory ──
{
  await sh("mkdir -p docs && printf 'x\\n' > docs/x.md && printf 'more\\n' >> a.txt");
  const s = await sh("git status --short", "/workspace/docs");
  check("`--short` from a subdirectory prints paths relative to it, as git does (`./` is the directory itself)",
    s.stdout === " M ../a.txt\n?? ./\n", JSON.stringify(s.stdout));
  const p = await porcelain("/workspace/docs");
  check("while `--porcelain` stays repository-relative", p === " M a.txt\n?? docs/\n", JSON.stringify(p));
}

// ── what this git does not do, said plainly ──
for (const verb of ["push", "pull", "fetch", "clone x"]) {
  const r = await sh(`git ${verb}`);
  if (verb === "push") {
    check("push, pull, fetch and clone exit 1 and say Kortix pushes the branch (/kortix/git/commit-push)",
      r.exitCode === 1 && r.stderr.includes("/kortix/git/commit-push"), JSON.stringify(r));
  } else if (r.exitCode !== 1 || !r.stderr.includes("/kortix/git/commit-push")) {
    check(`git ${verb} is refused the same way`, false, JSON.stringify(r));
  }
}
{
  const r = await sh("git stash");
  check("a subcommand outside the subset is exit 1 and names the ones that exist",
    r.exitCode === 1 && r.stderr.includes("'stash' is not supported") && r.stderr.includes("Supported: add, branch, checkout, commit"), JSON.stringify(r));
  const o = await sh("git log --graph");
  check("an option a subcommand does not have is git's usage error, exit 129", o.exitCode === 129 && /unknown option/.test(o.stderr), JSON.stringify(o));
}
{
  await sh("git config remote.origin.url https://x-access-token:SECRET@git.example.com/p.git && git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'");
  const r = await sh("git remote -v");
  check("`git remote -v` lists the remote without the credential in its URL",
    r.stdout === "origin\thttps://git.example.com/p.git (fetch)\norigin\thttps://git.example.com/p.git (push)\n" && !r.stdout.includes("SECRET"), JSON.stringify(r.stdout));
}

// ── it all lands in the cell's SQLite ──
{
  const again = cellFs(makeSql(db));
  await again.ready;
  const r = await cellExecutionEnv(again).exec("git log --oneline | wc -l; git status --porcelain");
  check("a new isolate on the same storage sees the same repository and the same changes",
    r.ok && r.value.stdout === "3\n M a.txt\n?? docs/\n", JSON.stringify(r.value?.stdout));
}

console.log(bad ? `\n  ${bad} failure(s) of ${claims}` : `\n  git runs in the cell's shell: ${claims} claims`);
process.exit(bad ? 1 : 0);
