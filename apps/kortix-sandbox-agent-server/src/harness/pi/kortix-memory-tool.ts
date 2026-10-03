/**
 * memory: a 1:1 port of Anthropic's `memory_20250818` tool, rooted at the
 * project's `memory/` folder. The same tool the project template gives an
 * OpenCode session, under the same name and arguments: six commands (view /
 * create / str_replace / insert / delete / rename) and the return strings the
 * model is trained to read. A refused command is a returned string, not a
 * thrown error, as in the reference backend.
 *
 * Every write is an ordinary file change under `memory/`, so memory edits
 * reach `main` through the normal change-request flow.
 *
 * Security (ported from the hardened SDK source):
 *  - the path boundary check uses a trailing separator, so a sibling directory
 *    such as `memory-evil` cannot pass as the root (CVE-2026-34451);
 *  - the symlink check walks to the deepest existing ancestor and verifies its
 *    real path stays inside the root;
 *  - files are created 0o600 and directories 0o700 (CVE-2026-41686);
 *  - writes are atomic (temp file, fsync, rename).
 */
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { StringEnum } from '@earendil-works/pi-ai'
import { Type } from 'typebox'

/** Repo-relative root every memory path must live under. */
const MEMORY_PREFIX = 'memory'

// Owner read/write only — Node's default 0o666 would be world-readable
// under a permissive umask (common in Docker base images).
const FILE_CREATE_MODE = 0o600
// fs.mkdir defaults to 0o777; lock memory dirs down the same way.
const DIR_CREATE_MODE = 0o700

const MAX_LINES = 999999
const LINE_NUMBER_WIDTH = String(MAX_LINES).length // 6

// ── helpers ──────────────────────────────────────────────────────────────

async function exists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return false
      throw err
    })
}

/**
 * fsync a directory so a newly created / renamed / removed entry is durable.
 *
 * This is the load-bearing half of 'create actually persisted': fsync-ing a
 * file only flushes its *contents* — the directory entry (the filename) lives
 * in the parent directory's metadata and is only guaranteed on disk after the
 * directory itself is fsynced. Without this, `create` can return success and
 * still vanish if the sandbox is snapshotted or killed before the dirent hits
 * disk. Best-effort: some platforms/filesystems (notably Windows) reject
 * fsync on a directory handle — those errors are non-fatal and ignored.
 */
async function fsyncDir(dirPath: string): Promise<void> {
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(dirPath, 'r')
    await handle.sync()
  } catch (err: any) {
    // EISDIR/EINVAL/EPERM/EACCES: platform can't fsync a dir handle — fine.
    if (!['EISDIR', 'EINVAL', 'EPERM', 'EACCES', 'ENOTSUP'].includes(err?.code)) {
      throw err
    }
  } finally {
    await handle?.close().catch(() => {})
  }
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0B'
  const k = 1024
  const sizes = ['B', 'K', 'M', 'G']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  const size = bytes / Math.pow(k, i)
  return (size % 1 === 0 ? size.toString() : size.toFixed(1)) + sizes[i]
}

/**
 * Write atomically: temp file (0o600) → fsync → rename. A crash mid-write
 * leaves either the complete old content or the complete new content.
 */
async function atomicWriteFile(targetPath: string, content: string): Promise<void> {
  const dir = path.dirname(targetPath)
  const tempPath = path.join(dir, `.tmp-${process.pid}-${randomUUID()}`)
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(tempPath, 'wx', FILE_CREATE_MODE)
    await handle.writeFile(content, 'utf-8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(tempPath, targetPath)
    // Persist the rename itself: the new dirent isn't durable until the
    // containing directory is fsynced.
    await fsyncDir(dir)
  } catch (err) {
    if (handle) await handle.close().catch(() => {})
    await fs.unlink(tempPath).catch(() => {})
    throw err
  }
}

/**
 * Reject paths that escape the memory root through a symlink. Walks up from
 * the target to the deepest existing ancestor, realpath-resolves it, and
 * verifies the real path is still inside the root.
 */
async function validateNoSymlinkEscape(targetPath: string, memoryRoot: string): Promise<void> {
  const resolvedRoot = await fs.realpath(memoryRoot)
  let current = targetPath
  while (true) {
    try {
      const resolved = await fs.realpath(current)
      if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
        throw new Error(`Path would escape ${MEMORY_PREFIX} directory via symlink`)
      }
      return
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err
      const parent = path.dirname(current)
      if (parent === current || current === memoryRoot) return
      current = parent
    }
  }
}

async function readFileContent(fullPath: string, memoryPath: string): Promise<string> {
  try {
    return await fs.readFile(fullPath, 'utf-8')
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `The file ${memoryPath} no longer exists (may have been deleted or renamed concurrently).`,
      )
    }
    throw err
  }
}

/** Resolve & sandbox a repo-relative memory path to an absolute path. */
async function validatePath(memoryPath: string, projectDir: string): Promise<string> {
  const root = path.resolve(projectDir, MEMORY_PREFIX)
  // Normalize a leading './' so both 'memory' and './memory' work.
  const cleaned = memoryPath.replace(/^\.\//, '')
  if (cleaned !== MEMORY_PREFIX && !cleaned.startsWith(MEMORY_PREFIX + '/')) {
    throw new Error(`Path must start with ${MEMORY_PREFIX}, got: ${memoryPath}`)
  }

  const resolved = path.resolve(projectDir, cleaned)
  // Trailing separator is load-bearing: without it, a sibling dir like
  // 'memory-evil' would pass the prefix check.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path ${memoryPath} would escape ${MEMORY_PREFIX} directory`)
  }

  await fs.mkdir(root, { recursive: true, mode: DIR_CREATE_MODE })
  await validateNoSymlinkEscape(resolved, root)
  return resolved
}

// ── command handlers ─────────────────────────────────────────────────────

async function view(memoryPath: string, viewRange: number[] | undefined, dir: string): Promise<string> {
  const fullPath = await validatePath(memoryPath, dir)

  let stat
  try {
    stat = await fs.stat(fullPath)
  } catch (err: any) {
    if (err.code === 'ENOENT')
      return `The path ${memoryPath} does not exist. Please provide a valid path.`
    throw err
  }

  if (stat.isDirectory()) {
    const items: Array<{ size: string; path: string }> = []
    const collect = async (dirPath: string, rel: string, depth: number): Promise<void> => {
      if (depth > 2) return
      for (const item of (await fs.readdir(dirPath)).sort()) {
        if (item.startsWith('.') || item === 'node_modules') continue
        const itemPath = path.join(dirPath, item)
        const itemRel = rel ? `${rel}/${item}` : item
        let s
        try {
          s = await fs.stat(itemPath)
        } catch {
          continue
        }
        if (s.isDirectory()) {
          items.push({ size: formatFileSize(s.size), path: `${itemRel}/` })
          if (depth < 2) await collect(itemPath, itemRel, depth + 1)
        } else if (s.isFile()) {
          items.push({ size: formatFileSize(s.size), path: itemRel })
        }
      }
    }
    await collect(fullPath, '', 1)

    const header = `Here're the files and directories up to 2 levels deep in ${memoryPath}, excluding hidden items and node_modules:`
    const lines = [
      `${formatFileSize(stat.size)}\t${memoryPath}`,
      ...items.map((it) => `${it.size}\t${memoryPath}/${it.path}`),
    ]
    return `${header}\n${lines.join('\n')}`
  }

  if (stat.isFile()) {
    const content = await readFileContent(fullPath, memoryPath)
    const allLines = content.split('\n')
    if (allLines.length > MAX_LINES) {
      return `File ${memoryPath} has too many lines (${allLines.length}). Maximum is ${MAX_LINES.toLocaleString()} lines.`
    }
    let display = allLines
    let startNum = 1
    if (viewRange && viewRange.length === 2) {
      const start = Math.max(1, viewRange[0]!) - 1
      const end = viewRange[1] === -1 ? allLines.length : viewRange[1]
      display = allLines.slice(start, end)
      startNum = start + 1
    }
    const numbered = display.map(
      (line, i) => `${String(i + startNum).padStart(LINE_NUMBER_WIDTH, ' ')}\t${line}`,
    )
    return `Here's the content of ${memoryPath} with line numbers:\n${numbered.join('\n')}`
  }

  return `Unsupported file type for ${memoryPath}`
}

async function create(memoryPath: string, fileText: string, dir: string): Promise<string> {
  const fullPath = await validatePath(memoryPath, dir)
  const parent = path.dirname(fullPath)
  await fs.mkdir(parent, { recursive: true, mode: DIR_CREATE_MODE })
  let handle: fs.FileHandle | undefined
  try {
    // 'wx' atomically claims a fresh name (no truncation of an existing file).
    handle = await fs.open(fullPath, 'wx', FILE_CREATE_MODE)
    await handle.writeFile(fileText, 'utf-8')
    await handle.sync()
    await handle.close()
    handle = undefined
  } catch (err: any) {
    if (err?.code === 'EEXIST') return `Error: File ${memoryPath} already exists`
    throw err
  } finally {
    await handle?.close().catch(() => {})
  }
  // Without this, the file's *contents* are flushed but its directory entry
  // may not be — so a create can report success yet not survive a snapshot.
  await fsyncDir(parent)
  return `File created successfully at: ${memoryPath}`
}

async function strReplace(
  memoryPath: string,
  oldStr: string,
  newStr: string,
  dir: string,
): Promise<string> {
  const fullPath = await validatePath(memoryPath, dir)
  let stat
  try {
    stat = await fs.stat(fullPath)
  } catch (err: any) {
    if (err.code === 'ENOENT')
      return `Error: The path ${memoryPath} does not exist. Please provide a valid path.`
    throw err
  }
  if (!stat.isFile()) return `Error: The path ${memoryPath} is not a file.`

  const content = await readFileContent(fullPath, memoryPath)
  const lines = content.split('\n')
  const matching: number[] = []
  lines.forEach((line, i) => {
    if (line.includes(oldStr)) matching.push(i + 1)
  })

  if (matching.length === 0) {
    return `No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${memoryPath}.`
  }
  if (matching.length > 1) {
    return `No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines: ${matching.join(', ')}. Please ensure it is unique`
  }

  const newContent = content.replace(oldStr, newStr)
  await atomicWriteFile(fullPath, newContent)

  const newLines = newContent.split('\n')
  const changed = matching[0]! - 1
  const from = Math.max(0, changed - 2)
  const to = Math.min(newLines.length, changed + 3)
  const snippet = newLines
    .slice(from, to)
    .map((line, i) => `${String(from + i + 1).padStart(LINE_NUMBER_WIDTH, ' ')}\t${line}`)
  return `The memory file has been edited. Here is the snippet showing the change (with line numbers):\n${snippet.join('\n')}`
}

async function insert(
  memoryPath: string,
  insertLine: number,
  insertText: string,
  dir: string,
): Promise<string> {
  const fullPath = await validatePath(memoryPath, dir)
  let stat
  try {
    stat = await fs.stat(fullPath)
  } catch (err: any) {
    if (err.code === 'ENOENT')
      return `Error: The path ${memoryPath} does not exist. Please provide a valid path.`
    throw err
  }
  if (!stat.isFile()) return `Error: The path ${memoryPath} is not a file.`

  const content = await readFileContent(fullPath, memoryPath)
  const lines = content.split('\n')
  if (insertLine < 0 || insertLine > lines.length) {
    return `Error: Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${lines.length}]`
  }
  lines.splice(insertLine, 0, insertText.replace(/\n$/, ''))
  await atomicWriteFile(fullPath, lines.join('\n'))
  return `The file ${memoryPath} has been edited.`
}

async function del(memoryPath: string, dir: string): Promise<string> {
  const fullPath = await validatePath(memoryPath, dir)
  const cleaned = memoryPath.replace(/^\.\//, '')
  if (cleaned === MEMORY_PREFIX) return `Cannot delete the ${MEMORY_PREFIX} directory itself`
  try {
    await fs.rm(fullPath, { recursive: true, force: false })
  } catch (err: any) {
    if (err.code === 'ENOENT') return `Error: The path ${memoryPath} does not exist`
    throw err
  }
  await fsyncDir(path.dirname(fullPath))
  return `Successfully deleted ${memoryPath}`
}

async function rename(oldPath: string, newPath: string, dir: string): Promise<string> {
  const oldFull = await validatePath(oldPath, dir)
  const newFull = await validatePath(newPath, dir)
  // POSIX rename() silently overwrites; best-effort guard.
  if (await exists(newFull)) return `Error: The destination ${newPath} already exists`
  const newParent = path.dirname(newFull)
  await fs.mkdir(newParent, { recursive: true, mode: DIR_CREATE_MODE })
  try {
    await fs.rename(oldFull, newFull)
  } catch (err: any) {
    if (err.code === 'ENOENT') return `Error: The path ${oldPath} does not exist`
    throw err
  }
  // Persist both sides of the move (the entry left one dir and entered another).
  await fsyncDir(newParent)
  await fsyncDir(path.dirname(oldFull))
  return `Successfully renamed ${oldPath} to ${newPath}`
}

const memorySchema = Type.Object({
  command: StringEnum(['view', 'create', 'str_replace', 'insert', 'delete', 'rename'] as const, { description: 'The memory operation to perform.' }),
  path: Type.Optional(
    Type.String({ description: 'Repo-relative path under `memory` (e.g. `memory/overview.md`). Required for view, create, str_replace, insert, delete.' }),
  ),
  view_range: Type.Optional(Type.Array(Type.Number(), { description: 'Optional [start, end] line range for `view` of a file. Use -1 for end-of-file.' })),
  file_text: Type.Optional(Type.String({ description: 'File contents. Required for `create`.' })),
  old_str: Type.Optional(Type.String({ description: 'Exact text to replace (must be unique in the file). Required for `str_replace`.' })),
  new_str: Type.Optional(Type.String({ description: 'Replacement text. Required for `str_replace` (use empty string to delete).' })),
  insert_line: Type.Optional(Type.Number({ description: 'Line number to insert after (0 = top of file). Required for `insert`.' })),
  insert_text: Type.Optional(Type.String({ description: 'Text to insert. Required for `insert`.' })),
  old_path: Type.Optional(Type.String({ description: 'Source path. Required for `rename`.' })),
  new_path: Type.Optional(Type.String({ description: 'Destination path. Required for `rename`.' })),
})

/** `dir` is the project checkout: every memory path resolves under `<dir>/memory`. */
export function createMemoryTool(dir: string): AgentTool<typeof memorySchema, undefined> {
  const run = async (args: Record<string, any>): Promise<string> => {
    const need = (...names: string[]) => names.find((name) => args[name] === undefined || (name.endsWith('path') && !args[name]))
    const missing = (name: string) => `Error: \`${name}\` is required for ${args.command}.`
    let absent: string | undefined
    switch (args.command) {
      case 'view':
        return (absent = need('path')) ? missing(absent) : view(args.path, args.view_range, dir)
      case 'create':
        return (absent = need('path', 'file_text')) ? missing(absent) : create(args.path, args.file_text, dir)
      case 'str_replace':
        return (absent = need('path', 'old_str', 'new_str')) ? missing(absent) : strReplace(args.path, args.old_str, args.new_str, dir)
      case 'insert':
        return (absent = need('path', 'insert_line', 'insert_text')) ? missing(absent) : insert(args.path, args.insert_line, args.insert_text, dir)
      case 'delete':
        return (absent = need('path')) ? missing(absent) : del(args.path, dir)
      case 'rename':
        return (absent = need('old_path', 'new_path')) ? missing(absent) : rename(args.old_path, args.new_path, dir)
      default:
        return 'Error: unknown command'
    }
  }
  return {
    name: 'memory',
    label: 'memory',
    description:
      'Persistent project memory — read, write, and curate the project brain in `memory/`. ' +
      'This is the canonical way to work with memory; use it instead of the generic read/edit/write tools for anything under `memory/`. ' +
      'Memory persists across sessions and is shared with the whole team via the repo, so write durable facts here. ' +
      'ALWAYS `view` `memory` before starting a task to recover prior context, and record durable progress as you go — your context window may reset at any time.\n\n' +
      'Paths are repo-relative and MUST start with `memory` (e.g. `memory/overview.md`). ' +
      "Keep memory coherent and organized: prefer editing existing files, rename or delete stale ones, and don't create new files unless a topic deserves its own page. " +
      'Always keep `memory/MEMORY.md` (the index) in sync — one line per sub-file. ' +
      'Never store secrets, tokens, or PII. Edits land on `main` through the normal change-request flow.\n\n' +
      'Commands: `view` (dir listing or file with line numbers; optional view_range), `create` (new file), ' +
      '`str_replace` (replace a unique snippet), `insert` (insert at a line), `delete` (remove file/dir), `rename` (move file/dir).',
    parameters: memorySchema,
    async execute(_id, args) {
      const output = await run(args).catch((err) => `Error: ${err?.message ?? String(err)}`)
      return { content: [{ type: 'text', text: output }], details: undefined }
    },
  }
}
