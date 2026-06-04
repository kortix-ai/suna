/**
 * memory — a 1:1 port of Anthropic's `memory_20250818` tool.
 *
 * Same six commands (view / create / str_replace / insert / delete /
 * rename), the same return strings the model is trained to read, and the
 * same security model as the official `BetaLocalFilesystemMemoryTool`
 * reference backend — but rooted at the project's real `.kortix/memory/`
 * folder instead of a virtual `/memories` mount.
 *
 * Because every write is an ordinary file change under `.kortix/memory/`,
 * memory edits flow through the normal Kortix change-request pipeline
 * (and the `memory-reflector` agent) exactly like code.
 *
 * Paths are repo-relative and MUST live under `.kortix/memory`
 * (e.g. `.kortix/memory/overview.md`). Nothing is auto-injected: the agent
 * rules + this tool's description carry the memory protocol — `view` your
 * memory before starting a task, and record durable progress as you go.
 *
 * Security (ported verbatim from the hardened SDK source, post-CVE):
 *  - path boundary check uses a trailing separator so a sibling dir like
 *    `.kortix/memory-evil` cannot masquerade as the root (CVE-2026-34451);
 *  - symlink-escape check walks to the deepest existing ancestor and
 *    realpath-verifies it stays inside the root;
 *  - files are written 0o600 and dirs created 0o700 so a permissive
 *    container umask can't expose memory (CVE-2026-41686);
 *  - writes are atomic (temp + fsync + rename).
 */

import { tool } from "@opencode-ai/plugin";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { featureDisabled, disabledResult } from "./lib/runtime-gate";

/** Repo-relative root every memory path must live under. */
const MEMORY_PREFIX = ".kortix/memory";

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
  // Normalize a leading "./" so both ".kortix/memory" and "./.kortix/memory" work.
  const cleaned = memoryPath.replace(/^\.\//, "");
  if (cleaned !== MEMORY_PREFIX && !cleaned.startsWith(MEMORY_PREFIX + "/")) {
    throw new Error(`Path must start with ${MEMORY_PREFIX}, got: ${memoryPath}`);
  }

  const resolved = path.resolve(projectDir, cleaned);
  // Trailing separator is load-bearing: without it, a sibling dir like
  // ".kortix/memory-evil" would pass the prefix check.
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
  await fs.mkdir(path.dirname(fullPath), { recursive: true, mode: DIR_CREATE_MODE });
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(fullPath, "wx", FILE_CREATE_MODE);
    await handle.writeFile(fileText, "utf-8");
    await handle.sync();
  } catch (err: any) {
    if (err?.code === "EEXIST") return `Error: File ${memoryPath} already exists`;
    throw err;
  } finally {
    await handle?.close().catch(() => {});
  }
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
  return `Successfully deleted ${memoryPath}`;
}

async function rename(oldPath: string, newPath: string, dir: string): Promise<string> {
  const oldFull = await validatePath(oldPath, dir);
  const newFull = await validatePath(newPath, dir);
  // POSIX rename() silently overwrites; best-effort guard.
  if (await exists(newFull)) return `Error: The destination ${newPath} already exists`;
  await fs.mkdir(path.dirname(newFull), { recursive: true, mode: DIR_CREATE_MODE });
  try {
    await fs.rename(oldFull, newFull);
  } catch (err: any) {
    if (err.code === "ENOENT") return `Error: The path ${oldPath} does not exist`;
    throw err;
  }
  return `Successfully renamed ${oldPath} to ${newPath}`;
}

// ── tool definition ────────────────────────────────────────────────────────

export default tool({
  description:
    "Persistent project memory — read, write, and curate the project brain in `.kortix/memory/`. " +
    "This is the canonical way to work with memory; use it instead of the generic read/edit/write tools for anything under `.kortix/memory/`. " +
    "Memory persists across sessions and is shared with the whole team via the repo, so write durable facts here. " +
    "ALWAYS `view` `.kortix/memory` before starting a task to recover prior context, and record durable progress as you go — your context window may reset at any time.\n\n" +
    "Paths are repo-relative and MUST start with `.kortix/memory` (e.g. `.kortix/memory/overview.md`). " +
    "Keep memory coherent and organized: prefer editing existing files, rename or delete stale ones, and don't create new files unless a topic deserves its own page. " +
    "Always keep `.kortix/memory/MEMORY.md` (the index) in sync — one line per sub-file. " +
    "Never store secrets, tokens, or PII. Edits land on `main` through the normal change-request flow.\n\n" +
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
        "Repo-relative path under `.kortix/memory` (e.g. `.kortix/memory/overview.md`). Required for view, create, str_replace, insert, delete.",
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
    if (featureDisabled("memory")) return disabledResult("memory", "memory");
    const dir = context.directory;
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
  },
});
