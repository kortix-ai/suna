// memory: KORTIXD'S PORT OF ANTHROPIC'S `memory_20250818` TOOL, IN A CELL.
//
// A port of apps/kortix-sandbox-agent-server/src/harness/pi/kortix-memory-tool.ts,
// rooted at the project's `memory/` folder: the same six commands (view /
// create / str_replace / insert / delete / rename), the same arguments and
// the same return strings the model is trained to read. A refused command is
// a returned string, not a thrown error, as in the reference backend.
//
// kortixd runs on `node:fs`. Here every file operation goes through the
// session's ExecutionEnv (the cell's own tree, or an attached machine), so
// memory lands in the same /workspace the bash, read and edit tools see, and
// reaches `main` through the normal change-request flow.
//
// Security, as in kortixd:
//  - the path boundary check uses a trailing separator, so a sibling directory
//    such as `memory-evil` cannot pass as the root;
//  - the symlink check walks to the deepest existing ancestor and verifies its
//    canonical path stays inside the root;
//  - writes to an existing file go through a temp file and a rename.
// Not ported: the 0o600/0o700 modes and the fsync calls. The ExecutionEnv has
// no chmod and no directory fsync; the cell's tree persists on every mutation.
import { Type } from "typebox";

/** Repo-relative root every memory path must live under. */
const MEMORY_PREFIX = "memory";

const MAX_LINES = 999999;
const LINE_NUMBER_WIDTH = String(MAX_LINES).length; // 6

// ── helpers ──────────────────────────────────────────────────────────────

/** POSIX `path.resolve(base, p)`. */
export function resolvePosix(base, p) {
  const joined = String(p).startsWith("/") ? String(p) : `${base}/${p}`;
  const out = [];
  for (const seg of joined.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}

const dirname = (p) => p.slice(0, p.lastIndexOf("/")) || "/";

/** A failed ExecutionEnv Result as the error it carries. */
const failure = (r) => (r?.error instanceof Error ? r.error : new Error(String(r?.error?.message ?? r?.error ?? "unknown error")));
const must = (r) => {
  if (!r?.ok) throw failure(r);
  return r.value;
};
const notFound = (r) => !r?.ok && r?.error?.code === "not_found";

function formatFileSize(bytes) {
  if (bytes === 0) return "0B";
  const k = 1024;
  const sizes = ["B", "K", "M", "G"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const size = bytes / Math.pow(k, i);
  return (size % 1 === 0 ? size.toString() : size.toFixed(1)) + sizes[i];
}

const randomId = () =>
  typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

/**
 * Metadata of what `path` names, symbolic links followed (kortixd's
 * `fs.stat`). The ExecutionEnv's `fileInfo` does not follow, so the path is
 * canonicalised first.
 */
async function stat(fs, path) {
  const real = await fs.canonicalPath(path);
  if (!real.ok) return real;
  return fs.fileInfo(real.value);
}

/**
 * Write atomically: temp file → rename. A crash mid-write leaves either the
 * complete old content or the complete new content.
 */
async function atomicWriteFile(fs, targetPath, content) {
  const tempPath = `${dirname(targetPath)}/.tmp-${randomId()}`;
  try {
    must(await fs.writeFile(tempPath, content));
    must(await fs.renameFile(tempPath, targetPath));
  } catch (err) {
    await fs.remove(tempPath, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Reject paths that escape the memory root through a symlink. Walks up from
 * the target to the deepest existing ancestor, canonicalises it, and verifies
 * the real path is still inside the root.
 */
async function validateNoSymlinkEscape(fs, targetPath, memoryRoot) {
  const resolvedRoot = must(await fs.canonicalPath(memoryRoot));
  let current = targetPath;
  while (true) {
    const r = await fs.canonicalPath(current);
    if (r.ok) {
      if (r.value !== resolvedRoot && !r.value.startsWith(`${resolvedRoot}/`)) {
        throw new Error(`Path would escape ${MEMORY_PREFIX} directory via symlink`);
      }
      return;
    }
    if (!notFound(r)) throw failure(r);
    const parent = dirname(current);
    if (parent === current || current === memoryRoot) return;
    current = parent;
  }
}

async function readFileContent(fs, fullPath, memoryPath) {
  const r = await fs.readTextFile(fullPath);
  if (notFound(r)) {
    throw new Error(`The file ${memoryPath} no longer exists (may have been deleted or renamed concurrently).`);
  }
  return must(r);
}

/** Resolve and sandbox a repo-relative memory path to an absolute path. */
async function validatePath(fs, memoryPath, projectDir) {
  const root = resolvePosix(projectDir, MEMORY_PREFIX);
  // Normalize a leading './' so both 'memory' and './memory' work.
  const cleaned = memoryPath.replace(/^\.\//, "");
  if (cleaned !== MEMORY_PREFIX && !cleaned.startsWith(`${MEMORY_PREFIX}/`)) {
    throw new Error(`Path must start with ${MEMORY_PREFIX}, got: ${memoryPath}`);
  }

  const resolved = resolvePosix(projectDir, cleaned);
  // Trailing separator is load-bearing: without it, a sibling dir like
  // 'memory-evil' would pass the prefix check.
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new Error(`Path ${memoryPath} would escape ${MEMORY_PREFIX} directory`);
  }

  must(await fs.createDir(root, { recursive: true }));
  await validateNoSymlinkEscape(fs, resolved, root);
  return resolved;
}

// ── command handlers ─────────────────────────────────────────────────────

async function view(fs, memoryPath, viewRange, dir) {
  const fullPath = await validatePath(fs, memoryPath, dir);

  const s = await stat(fs, fullPath);
  if (notFound(s)) return `The path ${memoryPath} does not exist. Please provide a valid path.`;
  const info = must(s);

  if (info.kind === "directory") {
    const items = [];
    const collect = async (dirPath, rel, depth) => {
      if (depth > 2) return;
      const names = must(await fs.listDir(dirPath)).map((e) => e.name).sort();
      for (const item of names) {
        if (item.startsWith(".") || item === "node_modules") continue;
        const itemPath = `${dirPath}/${item}`;
        const itemRel = rel ? `${rel}/${item}` : item;
        const is = await stat(fs, itemPath);
        if (!is.ok) continue;
        if (is.value.kind === "directory") {
          items.push({ size: formatFileSize(is.value.size), path: `${itemRel}/` });
          if (depth < 2) await collect(itemPath, itemRel, depth + 1);
        } else if (is.value.kind === "file") {
          items.push({ size: formatFileSize(is.value.size), path: itemRel });
        }
      }
    };
    await collect(fullPath, "", 1);

    const header = `Here're the files and directories up to 2 levels deep in ${memoryPath}, excluding hidden items and node_modules:`;
    const lines = [
      `${formatFileSize(info.size)}\t${memoryPath}`,
      ...items.map((it) => `${it.size}\t${memoryPath}/${it.path}`),
    ];
    return `${header}\n${lines.join("\n")}`;
  }

  if (info.kind === "file") {
    const content = await readFileContent(fs, fullPath, memoryPath);
    const allLines = content.split("\n");
    if (allLines.length > MAX_LINES) {
      return `File ${memoryPath} has too many lines (${allLines.length}). Maximum is ${MAX_LINES.toLocaleString()} lines.`;
    }
    let display = allLines;
    let startNum = 1;
    if (viewRange && viewRange.length === 2) {
      const start = Math.max(1, viewRange[0]) - 1;
      const end = viewRange[1] === -1 ? allLines.length : viewRange[1];
      display = allLines.slice(start, end);
      startNum = start + 1;
    }
    const numbered = display.map((line, i) => `${String(i + startNum).padStart(LINE_NUMBER_WIDTH, " ")}\t${line}`);
    return `Here's the content of ${memoryPath} with line numbers:\n${numbered.join("\n")}`;
  }

  return `Unsupported file type for ${memoryPath}`;
}

async function create(fs, memoryPath, fileText, dir) {
  const fullPath = await validatePath(fs, memoryPath, dir);
  // kortixd claims the name with an exclusive open ('wx'): an existing file or
  // directory is refused, never truncated.
  if (must(await fs.exists(fullPath))) return `Error: File ${memoryPath} already exists`;
  must(await fs.createDir(dirname(fullPath), { recursive: true }));
  must(await fs.writeFile(fullPath, fileText));
  return `File created successfully at: ${memoryPath}`;
}

async function strReplace(fs, memoryPath, oldStr, newStr, dir) {
  const fullPath = await validatePath(fs, memoryPath, dir);
  const s = await stat(fs, fullPath);
  if (notFound(s)) return `Error: The path ${memoryPath} does not exist. Please provide a valid path.`;
  if (must(s).kind !== "file") return `Error: The path ${memoryPath} is not a file.`;

  const content = await readFileContent(fs, fullPath, memoryPath);
  const lines = content.split("\n");
  const matching = [];
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
  await atomicWriteFile(fs, fullPath, newContent);

  const newLines = newContent.split("\n");
  const changed = matching[0] - 1;
  const from = Math.max(0, changed - 2);
  const to = Math.min(newLines.length, changed + 3);
  const snippet = newLines.slice(from, to).map((line, i) => `${String(from + i + 1).padStart(LINE_NUMBER_WIDTH, " ")}\t${line}`);
  return `The memory file has been edited. Here is the snippet showing the change (with line numbers):\n${snippet.join("\n")}`;
}

async function insert(fs, memoryPath, insertLine, insertText, dir) {
  const fullPath = await validatePath(fs, memoryPath, dir);
  const s = await stat(fs, fullPath);
  if (notFound(s)) return `Error: The path ${memoryPath} does not exist. Please provide a valid path.`;
  if (must(s).kind !== "file") return `Error: The path ${memoryPath} is not a file.`;

  const content = await readFileContent(fs, fullPath, memoryPath);
  const lines = content.split("\n");
  if (insertLine < 0 || insertLine > lines.length) {
    return `Error: Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${lines.length}]`;
  }
  lines.splice(insertLine, 0, insertText.replace(/\n$/, ""));
  await atomicWriteFile(fs, fullPath, lines.join("\n"));
  return `The file ${memoryPath} has been edited.`;
}

async function del(fs, memoryPath, dir) {
  const fullPath = await validatePath(fs, memoryPath, dir);
  const cleaned = memoryPath.replace(/^\.\//, "");
  if (cleaned === MEMORY_PREFIX) return `Cannot delete the ${MEMORY_PREFIX} directory itself`;
  const r = await fs.remove(fullPath, { recursive: true, force: false });
  if (notFound(r)) return `Error: The path ${memoryPath} does not exist`;
  must(r);
  return `Successfully deleted ${memoryPath}`;
}

async function rename(fs, oldPath, newPath, dir) {
  const oldFull = await validatePath(fs, oldPath, dir);
  const newFull = await validatePath(fs, newPath, dir);
  // POSIX rename() silently overwrites; best-effort guard.
  if (must(await fs.exists(newFull))) return `Error: The destination ${newPath} already exists`;
  must(await fs.createDir(dirname(newFull), { recursive: true }));
  const r = await fs.renameFile(oldFull, newFull);
  if (notFound(r)) return `Error: The path ${oldPath} does not exist`;
  must(r);
  return `Successfully renamed ${oldPath} to ${newPath}`;
}

/** pi-ai's `StringEnum`: a plain `enum` schema every provider accepts. */
const StringEnum = (values, options) => Type.Unsafe({ type: "string", enum: values, ...(options?.description && { description: options.description }) });

const memorySchema = Type.Object({
  command: StringEnum(["view", "create", "str_replace", "insert", "delete", "rename"], { description: "The memory operation to perform." }),
  path: Type.Optional(
    Type.String({ description: "Repo-relative path under `memory` (e.g. `memory/overview.md`). Required for view, create, str_replace, insert, delete." }),
  ),
  view_range: Type.Optional(Type.Array(Type.Number(), { description: "Optional [start, end] line range for `view` of a file. Use -1 for end-of-file." })),
  file_text: Type.Optional(Type.String({ description: "File contents. Required for `create`." })),
  old_str: Type.Optional(Type.String({ description: "Exact text to replace (must be unique in the file). Required for `str_replace`." })),
  new_str: Type.Optional(Type.String({ description: "Replacement text. Required for `str_replace` (use empty string to delete)." })),
  insert_line: Type.Optional(Type.Number({ description: "Line number to insert after (0 = top of file). Required for `insert`." })),
  insert_text: Type.Optional(Type.String({ description: "Text to insert. Required for `insert`." })),
  old_path: Type.Optional(Type.String({ description: "Source path. Required for `rename`." })),
  new_path: Type.Optional(Type.String({ description: "Destination path. Required for `rename`." })),
});

/**
 * `fsEnv()` is the fallback ExecutionEnv; a call made by pi uses the env pi
 * hands the tool (`ctx.env`), which is the same tree the other tools write.
 * Every memory path resolves under `<env.cwd>/memory`.
 */
export function createMemoryTool({ fsEnv } = {}) {
  const run = async (fs, args) => {
    const dir = fs.cwd || "/workspace";
    const need = (...names) => names.find((name) => args[name] === undefined || (name.endsWith("path") && !args[name]));
    const missing = (name) => `Error: \`${name}\` is required for ${args.command}.`;
    let absent;
    switch (args.command) {
      case "view":
        return (absent = need("path")) ? missing(absent) : view(fs, args.path, args.view_range, dir);
      case "create":
        return (absent = need("path", "file_text")) ? missing(absent) : create(fs, args.path, args.file_text, dir);
      case "str_replace":
        return (absent = need("path", "old_str", "new_str")) ? missing(absent) : strReplace(fs, args.path, args.old_str, args.new_str, dir);
      case "insert":
        return (absent = need("path", "insert_line", "insert_text")) ? missing(absent) : insert(fs, args.path, args.insert_line, args.insert_text, dir);
      case "delete":
        return (absent = need("path")) ? missing(absent) : del(fs, args.path, dir);
      case "rename":
        return (absent = need("old_path", "new_path")) ? missing(absent) : rename(fs, args.old_path, args.new_path, dir);
      default:
        return "Error: unknown command";
    }
  };
  return {
    name: "memory",
    label: "memory",
    description:
      "Persistent project memory — read, write, and curate the project brain in `memory/`. " +
      "This is the canonical way to work with memory; use it instead of the generic read/edit/write tools for anything under `memory/`. " +
      "Memory persists across sessions and is shared with the whole team via the repo, so write durable facts here. " +
      "ALWAYS `view` `memory` before starting a task to recover prior context, and record durable progress as you go — your context window may reset at any time.\n\n" +
      "Paths are repo-relative and MUST start with `memory` (e.g. `memory/overview.md`). " +
      "Keep memory coherent and organized: prefer editing existing files, rename or delete stale ones, and don't create new files unless a topic deserves its own page. " +
      "Always keep `memory/MEMORY.md` (the index) in sync — one line per sub-file. " +
      "Never store secrets, tokens, or PII. Edits land on `main` through the normal change-request flow.\n\n" +
      "Commands: `view` (dir listing or file with line numbers; optional view_range), `create` (new file), " +
      "`str_replace` (replace a unique snippet), `insert` (insert at a line), `delete` (remove file/dir), `rename` (move file/dir).",
    parameters: memorySchema,
    async execute(_id, args, _signal, _onUpdate, ctx) {
      const fs = ctx?.env ?? fsEnv?.();
      const output = fs
        ? await Promise.resolve().then(() => run(fs, args ?? {})).catch((err) => `Error: ${err?.message ?? String(err)}`)
        : "Error: the session has no workspace to keep memory in";
      return { content: [{ type: "text", text: output }], details: undefined };
    },
  };
}
