/**
 * memory — a 1:1 port of Anthropic's `memory_20250818` tool.
 *
 * Same six commands (view / create / str_replace / insert / delete /
 * rename), the same return strings the model is trained to read, and the
 * same security model as the official `BetaLocalFilesystemMemoryTool`
 * reference backend.
 *
 * Two homes for `memory/` paths:
 *  - Memory repos. When the Kortix daemon cloned the session's memory repos
 *    (git repos that follow the Agent Memory Repo spec) under `~/memory/`, it
 *    leaves `~/memory/.repos.json`. Paths are then `memory/<repo>/…`, and every
 *    write is committed and pushed at once: no change request. A push that
 *    loses a race is rebased and retried; a real conflict comes back as an
 *    error with this session's diff, and the remote version stays on disk.
 *  - Otherwise, the project's own `memory/` folder, whose edits land on `main`
 *    through the normal change-request flow.
 *
 * Security (ported verbatim from the hardened SDK source, post-CVE):
 *  - path boundary check uses a trailing separator so a sibling dir like
 *    `memory-evil` cannot masquerade as the root (CVE-2026-34451);
 *  - symlink-escape check walks to the deepest existing ancestor and
 *    realpath-verifies it stays inside the root;
 *  - files are written 0o600 and dirs created 0o700 so a permissive
 *    container umask can't expose memory (CVE-2026-41686);
 *  - writes are atomic (temp + fsync + rename).
 */

import { tool } from "./lib/tool";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

/** Repo-relative root every memory path must live under. */
const MEMORY_PREFIX = "memory";

// Owner read/write only — Node's default 0o666 would be world-readable
// under a permissive umask (common in Docker base images).
const FILE_CREATE_MODE = 0o600;
// fs.mkdir defaults to 0o777; lock memory dirs down the same way.
const DIR_CREATE_MODE = 0o700;

const MAX_LINES = 999999;
const LINE_NUMBER_WIDTH = String(MAX_LINES).length; // 6

// ── helpers ──────────────────────────────────────────────────────────────

async function exists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return false;
      throw err;
    });
}

/**
 * fsync a directory so a newly created / renamed / removed entry is durable.
 *
 * This is the load-bearing half of "create actually persisted": fsync-ing a
 * file only flushes its *contents* — the directory entry (the filename) lives
 * in the parent directory's metadata and is only guaranteed on disk after the
 * directory itself is fsynced. Without this, `create` can return success and
 * still vanish if the sandbox is snapshotted or killed before the dirent hits
 * disk. Best-effort: some platforms/filesystems (notably Windows) reject
 * fsync on a directory handle — those errors are non-fatal and ignored.
 */
async function fsyncDir(dirPath: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(dirPath, "r");
    await handle.sync();
  } catch (err: any) {
    // EISDIR/EINVAL/EPERM/EACCES: platform can't fsync a dir handle — fine.
    if (!["EISDIR", "EINVAL", "EPERM", "EACCES", "ENOTSUP"].includes(err?.code)) {
      throw err;
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0B";
  const k = 1024;
  const sizes = ["B", "K", "M", "G"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const size = bytes / Math.pow(k, i);
  return (size % 1 === 0 ? size.toString() : size.toFixed(1)) + sizes[i];
}

/**
 * Write atomically: temp file (0o600) → fsync → rename. A crash mid-write
 * leaves either the complete old content or the complete new content.
 */
async function atomicWriteFile(targetPath: string, content: string): Promise<void> {
  const dir = path.dirname(targetPath);
  const tempPath = path.join(dir, `.tmp-${process.pid}-${randomUUID()}`);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tempPath, "wx", FILE_CREATE_MODE);
    await handle.writeFile(content, "utf-8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tempPath, targetPath);
    // Persist the rename itself: the new dirent isn't durable until the
    // containing directory is fsynced.
    await fsyncDir(dir);
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }
}

/**
 * Reject paths that escape the memory root through a symlink. Walks up from
 * the target to the deepest existing ancestor, realpath-resolves it, and
 * verifies the real path is still inside the root.
 */
async function validateNoSymlinkEscape(targetPath: string, memoryRoot: string): Promise<void> {
  const resolvedRoot = await fs.realpath(memoryRoot);
  let current = targetPath;
  while (true) {
    try {
      const resolved = await fs.realpath(current);
      if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
        throw new Error(`Path would escape ${MEMORY_PREFIX} directory via symlink`);
      }
      return;
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err;
      const parent = path.dirname(current);
      if (parent === current || current === memoryRoot) return;
      current = parent;
    }
  }
}

async function readFileContent(fullPath: string, memoryPath: string): Promise<string> {
  try {
    return await fs.readFile(fullPath, "utf-8");
  } catch (err: any) {
    if (err.code === "ENOENT") {
      throw new Error(
        `The file ${memoryPath} no longer exists (may have been deleted or renamed concurrently).`,
      );
    }
    throw err;
  }
}

/** Resolve & sandbox a repo-relative memory path to an absolute path. */
async function validatePath(memoryPath: string, projectDir: string): Promise<string> {
  const root = path.resolve(projectDir, MEMORY_PREFIX);
  // Normalize a leading "./" so both "memory" and "./memory" work.
  const cleaned = memoryPath.replace(/^\.\//, "");
  if (cleaned !== MEMORY_PREFIX && !cleaned.startsWith(MEMORY_PREFIX + "/")) {
    throw new Error(`Path must start with ${MEMORY_PREFIX}, got: ${memoryPath}`);
  }

  const resolved = path.resolve(projectDir, cleaned);
  // Trailing separator is load-bearing: without it, a sibling dir like
  // "memory-evil" would pass the prefix check.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path ${memoryPath} would escape ${MEMORY_PREFIX} directory`);
  }

  await fs.mkdir(root, { recursive: true, mode: DIR_CREATE_MODE });
  await validateNoSymlinkEscape(resolved, root);
  return resolved;
}

// ── command handlers ─────────────────────────────────────────────────────

async function view(memoryPath: string, viewRange: number[] | undefined, dir: string): Promise<string> {
  const fullPath = await validatePath(memoryPath, dir);

  let stat;
  try {
    stat = await fs.stat(fullPath);
  } catch (err: any) {
    if (err.code === "ENOENT")
      return `The path ${memoryPath} does not exist. Please provide a valid path.`;
    throw err;
  }

  if (stat.isDirectory()) {
    const items: Array<{ size: string; path: string }> = [];
    const collect = async (dirPath: string, rel: string, depth: number): Promise<void> => {
      if (depth > 2) return;
      for (const item of (await fs.readdir(dirPath)).sort()) {
        if (item.startsWith(".") || item === "node_modules") continue;
        const itemPath = path.join(dirPath, item);
        const itemRel = rel ? `${rel}/${item}` : item;
        let s;
        try {
          s = await fs.stat(itemPath);
        } catch {
          continue;
        }
        if (s.isDirectory()) {
          items.push({ size: formatFileSize(s.size), path: `${itemRel}/` });
          if (depth < 2) await collect(itemPath, itemRel, depth + 1);
        } else if (s.isFile()) {
          items.push({ size: formatFileSize(s.size), path: itemRel });
        }
      }
    };
    await collect(fullPath, "", 1);

    const header = `Here're the files and directories up to 2 levels deep in ${memoryPath}, excluding hidden items and node_modules:`;
    const lines = [
      `${formatFileSize(stat.size)}\t${memoryPath}`,
      ...items.map((it) => `${it.size}\t${memoryPath}/${it.path}`),
    ];
    return `${header}\n${lines.join("\n")}`;
  }

  if (stat.isFile()) {
    const content = await readFileContent(fullPath, memoryPath);
    const allLines = content.split("\n");
    if (allLines.length > MAX_LINES) {
      return `File ${memoryPath} has too many lines (${allLines.length}). Maximum is ${MAX_LINES.toLocaleString()} lines.`;
    }
    let display = allLines;
    let startNum = 1;
    if (viewRange && viewRange.length === 2) {
      const start = Math.max(1, viewRange[0]!) - 1;
      const end = viewRange[1] === -1 ? allLines.length : viewRange[1];
      display = allLines.slice(start, end);
      startNum = start + 1;
    }
    const numbered = display.map(
      (line, i) => `${String(i + startNum).padStart(LINE_NUMBER_WIDTH, " ")}\t${line}`,
    );
    return `Here's the content of ${memoryPath} with line numbers:\n${numbered.join("\n")}`;
  }

  return `Unsupported file type for ${memoryPath}`;
}

async function create(memoryPath: string, fileText: string, dir: string): Promise<string> {
  const fullPath = await validatePath(memoryPath, dir);
  const parent = path.dirname(fullPath);
  await fs.mkdir(parent, { recursive: true, mode: DIR_CREATE_MODE });
  let handle: fs.FileHandle | undefined;
  try {
    // "wx" atomically claims a fresh name (no truncation of an existing file).
    handle = await fs.open(fullPath, "wx", FILE_CREATE_MODE);
    await handle.writeFile(fileText, "utf-8");
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (err: any) {
    if (err?.code === "EEXIST") return `Error: File ${memoryPath} already exists`;
    throw err;
  } finally {
    await handle?.close().catch(() => {});
  }
  // Without this, the file's *contents* are flushed but its directory entry
  // may not be — so a create can report success yet not survive a snapshot.
  await fsyncDir(parent);
  return `File created successfully at: ${memoryPath}`;
}

async function strReplace(
  memoryPath: string,
  oldStr: string,
  newStr: string,
  dir: string,
): Promise<string> {
  const fullPath = await validatePath(memoryPath, dir);
  let stat;
  try {
    stat = await fs.stat(fullPath);
  } catch (err: any) {
    if (err.code === "ENOENT")
      return `Error: The path ${memoryPath} does not exist. Please provide a valid path.`;
    throw err;
  }
  if (!stat.isFile()) return `Error: The path ${memoryPath} is not a file.`;

  const content = await readFileContent(fullPath, memoryPath);
  const lines = content.split("\n");
  const matching: number[] = [];
  lines.forEach((line, i) => {
    if (line.includes(oldStr)) matching.push(i + 1);
  });

  if (matching.length === 0) {
    return `No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${memoryPath}.`;
  }
  if (matching.length > 1) {
    return `No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines: ${matching.join(", ")}. Please ensure it is unique`;
  }

  const newContent = content.replace(oldStr, newStr);
  await atomicWriteFile(fullPath, newContent);

  const newLines = newContent.split("\n");
  const changed = matching[0]! - 1;
  const from = Math.max(0, changed - 2);
  const to = Math.min(newLines.length, changed + 3);
  const snippet = newLines
    .slice(from, to)
    .map((line, i) => `${String(from + i + 1).padStart(LINE_NUMBER_WIDTH, " ")}\t${line}`);
  return `The memory file has been edited. Here is the snippet showing the change (with line numbers):\n${snippet.join("\n")}`;
}

async function insert(
  memoryPath: string,
  insertLine: number,
  insertText: string,
  dir: string,
): Promise<string> {
  const fullPath = await validatePath(memoryPath, dir);
  let stat;
  try {
    stat = await fs.stat(fullPath);
  } catch (err: any) {
    if (err.code === "ENOENT")
      return `Error: The path ${memoryPath} does not exist. Please provide a valid path.`;
    throw err;
  }
  if (!stat.isFile()) return `Error: The path ${memoryPath} is not a file.`;

  const content = await readFileContent(fullPath, memoryPath);
  const lines = content.split("\n");
  if (insertLine < 0 || insertLine > lines.length) {
    return `Error: Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${lines.length}]`;
  }
  lines.splice(insertLine, 0, insertText.replace(/\n$/, ""));
  await atomicWriteFile(fullPath, lines.join("\n"));
  return `The file ${memoryPath} has been edited.`;
}

async function del(memoryPath: string, dir: string): Promise<string> {
  const fullPath = await validatePath(memoryPath, dir);
  const cleaned = memoryPath.replace(/^\.\//, "");
  if (cleaned === MEMORY_PREFIX) return `Cannot delete the ${MEMORY_PREFIX} directory itself`;
  try {
    await fs.rm(fullPath, { recursive: true, force: false });
  } catch (err: any) {
    if (err.code === "ENOENT") return `Error: The path ${memoryPath} does not exist`;
    throw err;
  }
  await fsyncDir(path.dirname(fullPath));
  return `Successfully deleted ${memoryPath}`;
}

async function rename(oldPath: string, newPath: string, dir: string): Promise<string> {
  const oldFull = await validatePath(oldPath, dir);
  const newFull = await validatePath(newPath, dir);
  // POSIX rename() silently overwrites; best-effort guard.
  if (await exists(newFull)) return `Error: The destination ${newPath} already exists`;
  const newParent = path.dirname(newFull);
  await fs.mkdir(newParent, { recursive: true, mode: DIR_CREATE_MODE });
  try {
    await fs.rename(oldFull, newFull);
  } catch (err: any) {
    if (err.code === "ENOENT") return `Error: The path ${oldPath} does not exist`;
    throw err;
  }
  // Persist both sides of the move (the entry left one dir and entered another).
  await fsyncDir(newParent);
  await fsyncDir(path.dirname(oldFull));
  return `Successfully renamed ${oldPath} to ${newPath}`;
}

// ── tool definition ────────────────────────────────────────────────────────

export default tool({
  description:
    "Persistent memory: read, write, and curate what this project and its people know, in `memory/`. " +
    "Use it instead of the generic read/edit/write tools for anything under `memory/`. " +
    "When the session has memory repos (listed in your instructions), `memory/company/` is the company memory everyone in the project shares and `memory/<user>/` is the personal memory of the user it names; " +
    "every write is committed and pushed at once, so other sessions see it, and a write that collides with another session comes back as an error with both versions to reconcile. " +
    "Otherwise `memory/` is a folder of the project repo and edits land on `main` through a change request.\n\n" +
    "Each repo has a `MEMORY.md` index that is loaded at session start; keep it short and link topic files from its `## Index` with `[[path]]`. " +
    "Entries are one-line bullets ending in `[source: <this session link>; added: YYYY-MM-DD]`. Update or remove stale entries instead of adding contradicting ones. " +
    "Write each fact to the repo of whoever it belongs to. Never store secrets, tokens, or credentials.\n\n" +
    "Commands: `view` (dir listing or file with line numbers; optional view_range), `create` (new file), " +
    "`str_replace` (replace a unique snippet), `insert` (insert at a line), `delete` (remove file/dir), `rename` (move file/dir).",
  args: {
    command: tool.schema
      .enum(["view", "create", "str_replace", "insert", "delete", "rename"])
      .describe("The memory operation to perform."),
    path: tool.schema
      .string()
      .optional()
      .describe(
        "Path under `memory` (e.g. `memory/company/MEMORY.md`, or `memory/overview.md` without memory repos). Required for view, create, str_replace, insert, delete.",
      ),
    view_range: tool.schema
      .array(tool.schema.number())
      .optional()
      .describe("Optional [start, end] line range for `view` of a file. Use -1 for end-of-file."),
    file_text: tool.schema.string().optional().describe("File contents. Required for `create`."),
    old_str: tool.schema
      .string()
      .optional()
      .describe("Exact text to replace (must be unique in the file). Required for `str_replace`."),
    new_str: tool.schema
      .string()
      .optional()
      .describe("Replacement text. Required for `str_replace` (use empty string to delete)."),
    insert_line: tool.schema
      .number()
      .optional()
      .describe("Line number to insert after (0 = top of file). Required for `insert`."),
    insert_text: tool.schema.string().optional().describe("Text to insert. Required for `insert`."),
    old_path: tool.schema.string().optional().describe("Source path. Required for `rename`."),
    new_path: tool.schema.string().optional().describe("Destination path. Required for `rename`."),
  },

  async execute(args, context) {
    const repos = readRepoManifest();
    if (!repos) return runCommand(args, context.directory);
    const paths = args.command === "rename" ? [args.old_path, args.new_path] : [args.path];
    if (args.command === "view" || paths.some((p) => !p)) return runCommand(args, path.dirname(REPO_ROOT));
    const refused = checkRepoWrite(repos, args.command, paths as string[]);
    if (refused) return refused;
    await refreshRepo(paths[0] as string);
    const result = await runCommand(args, path.dirname(REPO_ROOT));
    return syncRepoWrite(repos, args.command, paths as string[], result);
  },
});

async function runCommand(args: Record<string, any>, dir: string): Promise<string> {
  try {
    switch (args.command) {
      case "view":
        if (!args.path) return "Error: `path` is required for view.";
        return await view(args.path, args.view_range, dir);
      case "create":
        if (!args.path) return "Error: `path` is required for create.";
        if (args.file_text === undefined) return "Error: `file_text` is required for create.";
        return await create(args.path, args.file_text, dir);
      case "str_replace":
        if (!args.path) return "Error: `path` is required for str_replace.";
        if (args.old_str === undefined) return "Error: `old_str` is required for str_replace.";
        if (args.new_str === undefined) return "Error: `new_str` is required for str_replace.";
        return await strReplace(args.path, args.old_str, args.new_str, dir);
      case "insert":
        if (!args.path) return "Error: `path` is required for insert.";
        if (args.insert_line === undefined) return "Error: `insert_line` is required for insert.";
        if (args.insert_text === undefined) return "Error: `insert_text` is required for insert.";
        return await insert(args.path, args.insert_line, args.insert_text, dir);
      case "delete":
        if (!args.path) return "Error: `path` is required for delete.";
        return await del(args.path, dir);
      case "rename":
        if (!args.old_path) return "Error: `old_path` is required for rename.";
        if (!args.new_path) return "Error: `new_path` is required for rename.";
        return await rename(args.old_path, args.new_path, dir);
      default:
        return `Error: unknown command`;
    }
  } catch (err: any) {
    return `Error: ${err?.message ?? String(err)}`;
  }
}

// ── memory repos ──────────────────────────────────────────────────────────

/** Where the Kortix daemon clones the session's memory repos. */
const REPO_ROOT = path.join(homedir(), MEMORY_PREFIX);
const MEMORY_BRANCH = "main";
const WRITE_SUCCESS = /^(File created successfully|The memory file has been edited|The file .* has been edited\.|Successfully (deleted|renamed))/;

type RepoManifest = { repos: Array<{ name: string; label: string }>; source: string | null };

function readRepoManifest(): RepoManifest | null {
  try {
    const value = JSON.parse(readFileSync(path.join(REPO_ROOT, ".repos.json"), "utf8")) as RepoManifest;
    return Array.isArray(value.repos) && value.repos.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function splitRepoPath(p: string): { repo: string; rel: string } | null {
  const parts = p.replace(/^\.\//, "").split("/").filter(Boolean);
  if (parts[0] !== MEMORY_PREFIX || parts.length < 2) return null;
  return { repo: parts[1]!, rel: parts.slice(2).join("/") };
}

function checkRepoWrite(manifest: RepoManifest, command: string, paths: string[]): string | null {
  const names = manifest.repos.map((r) => r.name);
  const targets = paths.map(splitRepoPath);
  for (const [i, t] of targets.entries()) {
    if (!t || !names.includes(t.repo)) {
      return `Error: memory paths start with one of ${names.map((n) => `memory/${n}/`).join(", ")}; got ${paths[i]}`;
    }
    if (!t.rel) return `Error: ${command} works on files inside memory/${t.repo}/, not on the repo itself`;
  }
  if (new Set(targets.map((t) => t!.repo)).size > 1) {
    return "Error: rename cannot move files between memory repos; create the file in the other repo and delete this one";
  }
  return null;
}

function git(args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as any).code ?? 1) : 0, out: `${stdout}${stderr}`.trim() });
    });
  });
}

/** Before a write, catch up with what other sessions pushed, so only truly simultaneous edits collide. */
async function refreshRepo(p: string): Promise<void> {
  const target = splitRepoPath(p);
  if (!target) return;
  const cwd = path.join(REPO_ROOT, target.repo);
  if ((await git(["fetch", "--quiet", "origin"], cwd)).code !== 0) return;
  if ((await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${MEMORY_BRANCH}`], cwd)).code !== 0) return;
  if ((await git(["rebase", "--quiet", `origin/${MEMORY_BRANCH}`], cwd)).code !== 0) await git(["rebase", "--abort"], cwd);
}

/** Commit the write and push it at once; rebase and retry when another session pushed first. */
async function syncRepoWrite(manifest: RepoManifest, command: string, paths: string[], result: string): Promise<string> {
  if (!WRITE_SUCCESS.test(result)) return result;
  const targets = paths.map((p) => splitRepoPath(p)!);
  const cwd = path.join(REPO_ROOT, targets[0]!.repo);
  const rels = targets.map((t) => t.rel);
  const message = `${command} ${rels.join(" -> ")}${manifest.source ? `\n\nsource: ${manifest.source}` : ""}`;
  const added = await git(["add", "-A", "--", ...rels], cwd);
  if (added.code !== 0) return `${result}\nWarning: the change is on disk but was not committed: ${added.out}`;
  if ((await git(["diff", "--cached", "--quiet"], cwd)).code === 0) return result;
  const committed = await git(["commit", "--quiet", "-m", message], cwd);
  if (committed.code !== 0) return `${result}\nWarning: the change is on disk but was not committed: ${committed.out}`;
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const pushed = await git(["push", "--quiet", "origin", `HEAD:refs/heads/${MEMORY_BRANCH}`], cwd);
    if (pushed.code === 0) return `${result}\nCommitted and pushed.`;
    lastError = pushed.out;
    if ((await git(["fetch", "--quiet", "origin"], cwd)).code !== 0) break;
    const rebased = await git(["rebase", `origin/${MEMORY_BRANCH}`], cwd);
    if (rebased.code !== 0) {
      const conflicted = (await git(["diff", "--name-only", "--diff-filter=U"], cwd)).out;
      await git(["rebase", "--abort"], cwd);
      const mine = (await git(["show", "--format=", "HEAD"], cwd)).out;
      await git(["reset", "--hard", `origin/${MEMORY_BRANCH}`], cwd);
      return (
        `Error: Not saved: another session changed ${conflicted.split("\n").join(", ") || "the same lines"} at the same time. ` +
        "Their version is now on disk. Read the file again and re-apply your change on top of it. Your change was:\n" +
        mine.slice(0, 4000)
      );
    }
  }
  return `${result}\nCommitted locally; the push failed and is retried with the next memory write (${lastError.slice(0, 300)}).`;
}
