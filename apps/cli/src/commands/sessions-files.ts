import {
  mkdir as fsMkdir,
  readFile as fsReadFile,
  readdir as fsReaddir,
  stat as fsStat,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import {
  basename as localBasename,
  dirname as localDirname,
  join as localJoin,
  resolve as localResolve,
} from 'node:path';
import { posix } from 'node:path';

import { toSandboxAbsolutePath } from '@kortix/sdk';

import { kortixFromAuth } from '../api/sdk.ts';
import { emitJson, surfaceApiError, takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import { C, help, status } from '../style.ts';
import { loadSessionForChat } from './sessions-chat.ts';

const HELP = help`Usage: kortix sessions cp <src> <dst> [options]

Copy files between your machine and a session's sandbox, or directly
between two sandboxes in the project. scp-style refs:

  <session-id>:<path>    a path inside that session's sandbox
  <path>                 a local path (use ./name for names with a colon)

Sandbox paths resolve under /workspace unless absolute (/workspace, /tmp,
/home, /opt). The destination is overwritten at the exact path. Bytes are
relayed through this process — both sandboxes are woken if needed.

Examples:
  kortix sessions cp report.pdf ses_abc:out/report.pdf
  kortix sessions cp ses_abc:/workspace/dist/app.tar.gz .
  kortix sessions cp ses_abc:build/site ses_def:/workspace/site -r

Options:
  -r, --recursive    Copy directories recursively.
  --project <id>     Operate on this project id (default: linked).
  --host <name>      Operate against a non-default Kortix host.
  --json             Print the transferred files as JSON.
  -h, --help         Show this help.
`;

export type FileRef =
  | { kind: 'local'; path: string }
  | { kind: 'remote'; session: string; path: string };

/**
 * scp-style ref parsing: `<session>:<path>` is remote when the left side
 * looks like a session id (no `/`). Anything else is a local path.
 */
export function parseFileRef(arg: string): FileRef {
  const m = arg.match(/^([^/:]+):(.*)$/);
  if (m) return { kind: 'remote', session: m[1], path: m[2] };
  return { kind: 'local', path: arg };
}

/** cp semantics: a directory destination (or trailing slash) gets the source's name. */
export function joinDestPath(destPath: string, srcName: string, destIsDir: boolean): string {
  if (destPath.endsWith('/') || destIsDir || destPath === '') {
    return posix.join(destPath, srcName);
  }
  return destPath;
}

/** The subset of the SDK session `files` surface the copy engine needs. */
export interface SessionFilesOps {
  list(dirPath: string): Promise<Array<{ name: string; path: string; type: string }>>;
  readBlob(filePath: string): Promise<Blob>;
  upload(
    file: Blob,
    targetPath?: string,
    filename?: string,
  ): Promise<Array<{ path: string; size?: number }>>;
  remove(filePath: string): Promise<boolean>;
  mkdir(dirPath: string): Promise<boolean>;
  rename(from: string, to: string): Promise<boolean>;
}

/**
 * Write `content` to the EXACT `absPath` in a sandbox. The daemon's upload
 * endpoint never overwrites (it uniquifies colliding names), so: ensure the
 * parent dir, clear the target, upload, and rename into place if the daemon
 * still uniquified the name (e.g. a concurrent writer recreated it).
 */
export async function writeSessionFile(
  files: SessionFilesOps,
  absPath: string,
  content: Blob,
): Promise<{ path: string; bytes: number }> {
  const parent = posix.dirname(absPath);
  await files.mkdir(parent).catch(() => undefined);
  const temporaryName = `.${posix.basename(absPath)}.kortix-cp-${crypto.randomUUID()}`;
  const results = await files.upload(content, parent, temporaryName);
  const uploaded = results[0]?.path;
  if (!uploaded) {
    throw new Error(`upload returned no file for ${absPath}`);
  }
  const actual = toSandboxAbsolutePath(uploaded);
  const backupPath = `${absPath}.kortix-cp-backup-${crypto.randomUUID()}`;
  let backedUp = false;
  try {
    await files.rename(absPath, backupPath);
    backedUp = true;
  } catch {
    // A missing destination needs no backup.
  }
  try {
    await files.rename(actual, absPath);
  } catch (error) {
    if (backedUp) await files.rename(backupPath, absPath).catch(() => undefined);
    await files.remove(actual).catch(() => undefined);
    throw error;
  }
  if (backedUp) await files.remove(backupPath).catch(() => undefined);
  return { path: absPath, bytes: content.size };
}

/** Where `sessions new --with-file` uploads land. */
export const SESSION_INCOMING_DIR = '/workspace/incoming';

/**
 * Map local `--with-file` paths to their sandbox upload targets. Basenames
 * must be unique — the second upload would silently replace the first.
 */
export function uploadTargetsFor(localPaths: string[]): Array<{ local: string; target: string }> {
  const seen = new Set<string>();
  return localPaths.map((local) => {
    const name = localBasename(localResolve(local));
    if (seen.has(name)) {
      throw new Error(`duplicate --with-file basename "${name}" — rename one of the files`);
    }
    seen.add(name);
    return { local, target: `${SESSION_INCOMING_DIR}/${name}` };
  });
}

/** Reject missing paths and directories before provisioning a destination session. */
export async function validateUploadSources(
  uploads: Array<{ local: string; target: string }>,
): Promise<void> {
  for (const upload of uploads) {
    const source = await fsStat(upload.local);
    if (!source.isFile()) throw new Error(`--with-file expects a file: ${upload.local}`);
  }
}

/** Append the uploaded-file manifest to a prompt so the agent knows the paths. */
export function buildPromptWithFiles(prompt: string, sandboxPaths: string[]): string {
  if (sandboxPaths.length === 0) return prompt;
  const list = sandboxPaths.map((p) => `- ${p}`).join('\n');
  return `${prompt}\n\nFiles provided for this task (already in this sandbox):\n${list}`;
}

/**
 * Appended to every spawn prompt sent from INSIDE a sandbox (a coordinator
 * like the platform AGI agent). Without it a worker session sees the same
 * CLI + token its coordinator has and re-delegates instead of working — the
 * observed failure: "generate a demo PDF" spawned a session that spawned
 * another session.
 */
export const SESSION_CONTRACT = [
  '--- session contract ---',
  'You are a specialized work session. Do the task above yourself, in this sandbox, with your own tools.',
  'Do not spawn other sessions (no `kortix sessions new`) — the coordinator that started you manages the fleet.',
  'For Python use the preinstalled `uv` (`uv run` / `uvx` / `uv pip`), never bare `pip`.',
  'Write your deliverables to files under /workspace/out/ and state the exact paths in your final reply.',
].join('\n');

/** Compose the outgoing spawn prompt; in-sandbox callers get the contract. */
export function buildSpawnPrompt(prompt: string, opts: { fromSandbox: boolean }): string {
  if (!opts.fromSandbox) return prompt;
  return `${prompt}\n\n${SESSION_CONTRACT}`;
}

/**
 * The persisted model + agent a prompt to this session must carry (mirrors
 * the SDK's own `send()` resolution). An async prompt WITHOUT them lets
 * OpenCode fall back to its built-in default model, which is not provisioned
 * in Kortix sandboxes — the message lands but the agent loop never starts.
 */
export function sessionPromptDefaults(session: {
  agent_name?: string | null;
  metadata?: Record<string, unknown> | null;
}): { agent?: string; model?: { providerID: string; modelID: string } } {
  const metadata = session.metadata ?? {};
  const reference =
    typeof metadata.opencode_model === 'string' ? metadata.opencode_model.trim() : '';
  const separator = reference.indexOf('/');
  const model =
    separator > 0 && separator < reference.length - 1
      ? { providerID: reference.slice(0, separator), modelID: reference.slice(separator + 1) }
      : undefined;
  const agent = session.agent_name?.trim() || undefined;
  return { ...(agent ? { agent } : {}), ...(model ? { model } : {}) };
}

type Endpoint = { kind: 'local' } | { kind: 'remote'; sessionId: string; files: SessionFilesOps };

interface Transfer {
  from: string;
  to: string;
  bytes: number;
}

async function localIsDir(path: string): Promise<boolean | null> {
  try {
    return (await fsStat(path)).isDirectory();
  } catch {
    return null;
  }
}

/** A remote node's type via its parent's listing; null when it does not exist. */
async function remoteNodeType(files: SessionFilesOps, absPath: string): Promise<string | null> {
  if (absPath === '/workspace') return 'directory';
  const parent = posix.dirname(absPath);
  const nodes = await files.list(parent).catch(() => null);
  if (!nodes) return null;
  const node = nodes.find(
    (n) => toSandboxAbsolutePath(n.path) === absPath || n.name === posix.basename(absPath),
  );
  return node?.type ?? null;
}

async function walkLocal(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fsReaddir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walkLocal(localJoin(dir, entry.name), rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

async function walkRemote(files: SessionFilesOps, dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const node of await files.list(dir)) {
    const rel = prefix ? `${prefix}/${node.name}` : node.name;
    if (node.type === 'directory') {
      out.push(...(await walkRemote(files, posix.join(dir, node.name), rel)));
    } else {
      out.push(rel);
    }
  }
  return out;
}

async function readFrom(src: Endpoint, path: string): Promise<Blob> {
  if (src.kind === 'local') {
    const bytes = await fsReadFile(path);
    return new Blob([new Uint8Array(bytes)]);
  }
  return src.files.readBlob(path);
}

async function writeTo(dst: Endpoint, path: string, content: Blob): Promise<void> {
  if (dst.kind === 'local') {
    await fsMkdir(localDirname(localResolve(path)), { recursive: true });
    await fsWriteFile(path, new Uint8Array(await content.arrayBuffer()));
    return;
  }
  await writeSessionFile(dst.files, path, content);
}

function label(endpoint: Endpoint, path: string): string {
  return endpoint.kind === 'remote' ? `${endpoint.sessionId}:${path}` : path;
}

export async function runSessionsCp(argv: string[]): Promise<number> {
  const rest = [...argv];
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }
  let projectArg: string | undefined;
  let hostArg: string | undefined;
  let recursive = false;
  let json = false;
  try {
    projectArg = takeFlagValue(rest, ['--project']);
    hostArg = takeFlagValue(rest, ['--host']);
    recursive = takeFlagBool(rest, ['-r', '--recursive']);
    json = takeFlagBool(rest, ['--json']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const positional = rest.filter((a) => a === '-' || !a.startsWith('-'));
  if (positional.length !== 2) {
    process.stdout.write(HELP);
    return 2;
  }

  const srcRef = parseFileRef(positional[0]);
  const dstRef = parseFileRef(positional[1]);
  if (srcRef.kind === 'local' && dstRef.kind === 'local') {
    process.stderr.write(
      `${status.err('Both sides are local — use plain `cp`.')}\n` +
        `  ${C.dim}Prefix a sandbox path with its session id: \`ses_abc:out/report.pdf\`.${C.reset}\n`,
    );
    return 2;
  }

  // Resolve each referenced session once (same-session cp reuses the handle).
  const endpoints = new Map<string, SessionFilesOps>();
  for (const ref of [srcRef, dstRef]) {
    if (ref.kind !== 'remote' || endpoints.has(ref.session)) continue;
    const resolved = await loadSessionForChat(ref.session, { projectArg, hostArg }, 'sessions cp', {
      requireRunning: false,
    });
    if (!resolved) return 1;
    const handle = kortixFromAuth(resolved.auth).session(
      resolved.ctx.projectId,
      resolved.session.session_id,
    );
    endpoints.set(ref.session, handle.files as SessionFilesOps);
  }

  const src: Endpoint =
    srcRef.kind === 'local'
      ? { kind: 'local' }
      : { kind: 'remote', sessionId: srcRef.session, files: endpoints.get(srcRef.session)! };
  const dst: Endpoint =
    dstRef.kind === 'local'
      ? { kind: 'local' }
      : { kind: 'remote', sessionId: dstRef.session, files: endpoints.get(dstRef.session)! };

  const srcPath =
    srcRef.kind === 'remote' ? toSandboxAbsolutePath(srcRef.path || '/workspace') : srcRef.path;
  const rawDstPath = dstRef.kind === 'remote' ? dstRef.path || '/workspace' : dstRef.path;

  try {
    // Is the source a directory? (null = no such local path)
    const localSrcType = src.kind === 'local' ? await localIsDir(srcPath) : undefined;
    if (localSrcType === null) {
      process.stderr.write(`${status.err(`No such local file: ${srcPath}`)}\n`);
      return 1;
    }
    const srcIsDir =
      src.kind === 'local'
        ? (localSrcType ?? false)
        : (await remoteNodeType(src.files, srcPath)) === 'directory';
    if (srcIsDir && !recursive) {
      process.stderr.write(
        `${status.err(`${label(src, srcPath)} is a directory — pass -r to copy it.`)}\n`,
      );
      return 1;
    }

    // Is the destination an (existing) directory?
    const dstIsDir =
      dst.kind === 'local'
        ? ((await localIsDir(rawDstPath || '.')) ?? false)
        : (await remoteNodeType(dst.files, toSandboxAbsolutePath(rawDstPath))) === 'directory';

    const srcName =
      src.kind === 'local' ? localBasename(localResolve(srcPath)) : posix.basename(srcPath);
    const transfers: Transfer[] = [];

    if (srcIsDir) {
      // cp -r: an existing directory destination receives <dst>/<srcName>/…
      const destBase = joinDestPath(
        rawDstPath || (dst.kind === 'local' ? '.' : '/workspace'),
        srcName,
        dstIsDir,
      );
      const rels =
        src.kind === 'local' ? await walkLocal(srcPath) : await walkRemote(src.files, srcPath);
      if (rels.length === 0) {
        process.stderr.write(`${status.err(`${label(src, srcPath)} contains no files.`)}\n`);
        return 1;
      }
      for (const rel of rels) {
        const from = src.kind === 'local' ? localJoin(srcPath, rel) : posix.join(srcPath, rel);
        const to =
          dst.kind === 'local'
            ? localJoin(destBase, rel)
            : toSandboxAbsolutePath(posix.join(destBase, rel));
        const content = await readFrom(src, from);
        await writeTo(dst, to, content);
        transfers.push({ from: label(src, from), to: label(dst, to), bytes: content.size });
        if (!json)
          process.stdout.write(
            `  ${C.dim}${rel}${C.reset}  ${C.faded}${content.size} B${C.reset}\n`,
          );
      }
    } else {
      const to =
        dst.kind === 'local'
          ? joinDestPath(rawDstPath || '.', srcName, dstIsDir)
          : toSandboxAbsolutePath(joinDestPath(rawDstPath, srcName, dstIsDir));
      const content = await readFrom(src, srcPath);
      await writeTo(dst, to, content);
      transfers.push({ from: label(src, srcPath), to: label(dst, to), bytes: content.size });
    }

    if (json) {
      emitJson(transfers);
    } else {
      const total = transfers.reduce((sum, t) => sum + t.bytes, 0);
      process.stdout.write(
        `${status.ok(
          `Copied ${transfers.length} file${transfers.length === 1 ? '' : 's'} (${total} B) → ${transfers.length === 1 ? transfers[0].to : label(dst, rawDstPath || '.')}`,
        )}\n`,
      );
    }
    return 0;
  } catch (err) {
    return surfaceApiError(err);
  }
}
