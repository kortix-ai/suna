import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sessionAttachmentPath, type WorkspaceAttachment } from '../../../packages/shared/src/session-attachment-path';
import type { Config } from './config';

const MAX_BYTES = 8 * 1024 * 1024;

async function ensureDirectories(root: string, relative: string) {
  let current = await fs.realpath(root);
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    await fs.mkdir(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    if (!(await fs.lstat(current)).isDirectory()) throw new Error('attachment parent must be a directory');
  }
  return current;
}

export async function installSessionAttachment(cfg: Config, file: WorkspaceAttachment, signal: AbortSignal) {
  const relative = sessionAttachmentPath(file);
  signal.throwIfAborted();
  const target = path.join(cfg.workspace, relative);
  const state = path.join(cfg.agentStateDir ?? '/opt/kortix/environment-runtime', 'attachments');
  const identity = createHash('sha256').update(relative).digest('hex');
  const receipt = path.join(state, identity);
  if (await fs.readFile(receipt, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }) === relative) return { path: target };
  if (!cfg.apiUrl || !cfg.projectId || !cfg.sessionId || !cfg.sandboxToken) throw new Error('session attachment storage is unavailable');
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  const response = await fetch(`${cfg.apiUrl.replace(/\/$/, '')}/projects/${encodeURIComponent(cfg.projectId)}/sessions/${encodeURIComponent(cfg.sessionId)}/attachments/${file.sha256}`, {
    headers: { authorization: `Bearer ${cfg.sandboxToken}` },
    redirect: 'error',
    signal: requestSignal,
  });
  if (!response.ok || response.headers.get('content-type') !== file.mime) {
    await response.body?.cancel();
    throw new Error(`attachment download rejected: HTTP ${response.status}`);
  }
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel();
    throw new Error('attachment exceeds 8 MiB');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('attachment is empty');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > MAX_BYTES) {
        await reader.cancel();
        throw new Error('attachment exceeds 8 MiB');
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks, length);
  if (!length || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('attachment integrity check failed');
  const directory = await ensureDirectories(cfg.workspace, path.posix.dirname(relative));
  signal.throwIfAborted();
  const temporary = path.join(directory, `.upload-${crypto.randomUUID()}`);
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600, signal });
    await fs.link(temporary, target).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
      const stat = await fs.lstat(target);
      if (!stat.isFile() || stat.size !== length || !Buffer.from(await fs.readFile(target)).equals(bytes)) throw new Error('attachment destination already exists with different bytes');
    });
    await fs.mkdir(state, { recursive: true, mode: 0o700 });
    await fs.writeFile(receipt, relative, { flag: 'w', mode: 0o600 });
    return { path: target };
  } finally { await fs.rm(temporary, { force: true }); }
}
