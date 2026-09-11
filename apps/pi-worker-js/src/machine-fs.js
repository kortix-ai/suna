// THE MACHINE, SEEN AS A FILESYSTEM AND A GIT REPOSITORY.
//
// Once a session has attached its environment, that box is the workspace of
// record: the Files panel, the viewer, search, git status, the Changes tab and
// commit-push all have to answer about IT, not about the cell's own tree. Those
// routes are written over the small fs surface the cell's in-memory tree
// exposes (cell-files.js, cell-static.js): exists, stat, readdirWithFileTypes,
// readFileBuffer, writeFile, mkdir, rm, mv. This is that surface over the
// machine's RPC (execenv.envrpc.js), so the routes serve the machine unchanged.
//
// Two things a remote tree must not do the way an in-memory one does: walk
// itself one directory per round trip, and search itself one file per round
// trip. The machine has ripgrep and git, so `listAll` and `search` are one
// exec each — the same commands the daemon in a production box runs for the
// same routes (routes/find.ts). Git is git: status, diff and commit-push run
// as commands, because the box holds a real checkout with the Kortix proxy as
// its origin and a credential helper for it (measured 2026-09-11: `git push
// --dry-run` from inside an environment answered "Everything up-to-date").
//
// Pure over the ExecutionEnv it is handed, so every shape is asserted with a
// fake machine.
import { CELL_CWD } from "./execenv.cell.js";

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const MAX_FILES = 20_000;
const MAX_TEXT_MATCHES = 500;

/** A dirent in the shape cell-files reads: booleans, not methods. */
const dirent = (info) => ({ name: info.name, isDirectory: info.kind === "directory", isFile: info.kind === "file" });

/**
 * @param {object} env  an ExecutionEnv over the machine (execenv.envrpc.js)
 */
export function machineFs(env, workspace = CELL_CWD) {
  const abs = (p) => (String(p).startsWith("/") ? String(p) : `${workspace}/${p}`.replace(/\/+/g, "/"));
  async function sh(command, timeout = 60) {
    const r = await env.exec(command, { cwd: workspace, timeout });
    if (!r.ok) throw new Error(r.error?.message ?? "machine exec failed");
    return r.value;
  }
  const fs = {
    kind: "machine",
    async exists(p) {
      const r = await env.exists(abs(p));
      return r.ok ? !!r.value : false;
    },
    async stat(p) {
      const r = await env.fileInfo(abs(p));
      if (!r.ok) { const e = new Error(r.error?.message ?? "not found"); e.code = r.error?.code ?? "ENOENT"; throw e; }
      return { isDirectory: r.value.kind === "directory", isFile: r.value.kind === "file", size: r.value.size ?? 0, mtimeMs: r.value.mtimeMs ?? 0 };
    },
    async readdirWithFileTypes(p) {
      const r = await env.listDir(abs(p));
      if (!r.ok) { const e = new Error(r.error?.message ?? "not found"); e.code = r.error?.code ?? "ENOENT"; throw e; }
      return (r.value ?? []).map(dirent);
    },
    async readFileBuffer(p) {
      const r = await env.readBinaryFile(abs(p));
      if (!r.ok) { const e = new Error(r.error?.message ?? "not found"); e.code = r.error?.code ?? "ENOENT"; throw e; }
      return r.value;
    },
    async writeFile(p, content) {
      const r = await env.writeFile(abs(p), content);
      if (!r.ok) throw new Error(r.error?.message ?? "write failed");
    },
    async mkdir(p, options) {
      const r = await env.createDir(abs(p), { recursive: options?.recursive ?? true });
      if (!r.ok) throw new Error(r.error?.message ?? "mkdir failed");
    },
    async rm(p, options) {
      const r = await env.remove(abs(p), { recursive: !!options?.recursive, force: !!options?.force });
      if (!r.ok) throw new Error(r.error?.message ?? "remove failed");
    },
    async mv(from, to) {
      const r = await env.renameFile(abs(from), abs(to));
      if (!r.ok) throw new Error(r.error?.message ?? "rename failed");
    },
    /** Every file under the workspace, relative — one `rg --files`, as the daemon does it. */
    async listAll(root = workspace) {
      const out = await sh(`cd ${q(root)} && rg --files --hidden -g '!.git' -g '!node_modules' -g '!.next' -g '!dist' -g '!build' 2>/dev/null | head -n ${MAX_FILES}`);
      return out.stdout.split("\n").map((l) => l.replace(/^\.\//, "")).filter(Boolean);
    },
    /** `GET /find?pattern=` — ripgrep's own JSON, reduced to the route's match shape. */
    async search(pattern, root = workspace) {
      const out = await sh(`cd ${q(root)} && rg --json --hidden -g '!.git' -g '!node_modules' -e ${q(pattern)} 2>/dev/null | head -n 4000`);
      const matches = [];
      for (const line of out.stdout.split("\n")) {
        if (!line.startsWith("{")) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.type !== "match") continue;
        const d = m.data;
        const text = d.lines?.text ?? "";
        const path = String(d.path?.text ?? "");
        for (const sub of d.submatches ?? []) {
          matches.push({
            path: path.startsWith("./") ? path : `./${path}`,
            lines: text,
            line_number: d.line_number,
            absolute_offset: d.absolute_offset,
            submatches: [{ match: sub.match?.text ?? "", start: sub.start, end: sub.end }],
          });
          if (matches.length >= MAX_TEXT_MATCHES) return matches;
        }
      }
      return matches;
    },
  };
  return fs;
}

/** `git status --porcelain=v1 -z`, into the Files panel's status rows. */
export function parsePorcelain(raw) {
  const out = [];
  for (const entry of String(raw ?? "").split("\0")) {
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    // A rename carries "R  new\0old" — the old name arrives as the next entry
    // and is dropped by the length check only when short; take the new one.
    const status = xy === "??" || xy[0] === "A" || xy[1] === "A" ? "added"
      : xy[0] === "D" || xy[1] === "D" ? "deleted"
      : xy[0] === "R" ? "renamed"
      : "modified";
    out.push({ path, status, added: 0, removed: 0 });
  }
  return out;
}

/** `git diff --numstat` lines into `{path: {additions, deletions}}`. */
export function parseNumstat(raw) {
  const out = {};
  for (const line of String(raw ?? "").split("\n")) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    out[m[3]] = { additions: m[1] === "-" ? 0 : Number(m[1]), deletions: m[2] === "-" ? 0 : Number(m[2]) };
  }
  return out;
}

/** Git over the machine: status, per-file diffs, commit-push. */
export function machineGit(env, workspace = CELL_CWD) {
  async function sh(command, timeout = 120) {
    const r = await env.exec(command, { cwd: workspace, timeout });
    if (!r.ok) throw new Error(r.error?.message ?? "machine exec failed");
    return r.value;
  }
  return {
    /** The Files panel's `/file/status` rows, with line counts from numstat. */
    async status() {
      const st = await sh("git status --porcelain=v1 -z --untracked-files=all");
      const rows = parsePorcelain(st.stdout);
      if (!rows.length) return [];
      const ns = parseNumstat((await sh("git diff --numstat HEAD -- . 2>/dev/null; git diff --numstat -- . 2>/dev/null")).stdout);
      return rows.map((r) => ({ ...r, added: ns[r.path]?.additions ?? 0, removed: ns[r.path]?.deletions ?? 0 }));
    },
    /** OpenCode's `SnapshotFileDiff[]`: one entry per changed file with its own patch. */
    async fileDiffs() {
      const rows = await this.status();
      const out = [];
      for (const r of rows) {
        let patch = "";
        if (r.status === "added") {
          const d = await sh(`git diff --no-index --no-color -- /dev/null ${q(r.path)} 2>/dev/null || true`);
          patch = d.stdout;
        } else {
          const d = await sh(`git diff --no-color HEAD -- ${q(r.path)} 2>/dev/null || git diff --no-color -- ${q(r.path)}`);
          patch = d.stdout;
        }
        out.push({ file: r.path, patch, additions: r.added, deletions: r.removed, status: r.status === "renamed" ? "modified" : r.status });
      }
      return out;
    },
    /**
     * Commit everything and push the session branch. The box's origin is the
     * Kortix git proxy with a credential helper the daemon installed, so this
     * is plain git; nothing here needs the session token.
     */
    async commitAndPush({ branch, message }) {
      const st = await sh("git status --porcelain=v1 -z --untracked-files=all");
      if (!st.stdout.trim()) {
        const head = (await sh("git rev-parse HEAD")).stdout.trim();
        return { ok: true, committed: false, pushed: false, nothingToDo: true, branch, headSha: head };
      }
      const msg = message?.trim() || `Session work (${new Date().toISOString()})`;
      const c = await sh(`git add -A && git -c user.name=Kortix -c user.email=agent@kortix.ai commit -q -m ${q(msg)} && git rev-parse HEAD`);
      if (c.exitCode !== 0) return { ok: false, status: 500, error: `commit failed: ${(c.stderr || c.stdout).slice(0, 300)}` };
      const head = c.stdout.trim().split("\n").pop();
      const p = await sh(`git push origin HEAD:refs/heads/${branch} 2>&1`, 300);
      if (p.exitCode !== 0) return { ok: false, status: 502, error: `push failed: ${(p.stderr || p.stdout).slice(0, 300)}`, headSha: head };
      return { ok: true, committed: true, pushed: true, nothingToDo: false, branch, headSha: head };
    },
    /** Bring the machine's checkout up to the branch the cell just pushed. */
    async pull(branch) {
      const r = await sh(`git fetch -q origin ${branch} && git merge --ff-only FETCH_HEAD 2>&1`, 180);
      return { ok: r.exitCode === 0, output: (r.stdout + r.stderr).slice(0, 300) };
    },
  };
}
