import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { decodeCompiledAgentResources } from '../../../packages/manifest-schema/src/compiled-agent-resources';
import type { Config } from './config';

interface InstallOptions {
  workspace: string;
  helpers: string;
  state: string;
  sessionId: string;
  projectId: string;
  signal?: AbortSignal;
}

async function inspect(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function safeDirectory(path: string): Promise<void> {
  const absolute = resolve(path);
  let current = absolute.startsWith(sep) ? sep : '';
  for (const part of absolute.split(sep).filter(Boolean)) {
    current = join(current, part);
    await mkdir(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const entry = await lstat(current);
    if (entry.isSymbolicLink())
      throw new Error(`Agent resource directory is a symlink: ${current}`);
    if (!entry.isDirectory())
      throw new Error(`Agent resource parent is not a directory: ${current}`);
  }
}

async function atomicFile(
  path: string,
  bytes: Uint8Array,
  mode: number,
  replace: boolean,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  await safeDirectory(dirname(path));
  const existing = await inspect(path);
  if (existing && (existing.isSymbolicLink() || !existing.isFile()))
    throw new Error(`Agent resource destination is a symlink or non-file: ${path}`);
  if (existing && !replace) return;
  const temporary = join(dirname(path), `.kortix-resource-${crypto.randomUUID()}`);
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  );
  try {
    await handle.writeFile(bytes, { signal });
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    signal?.throwIfAborted();
    if (replace) await rename(temporary, path);
    else
      await link(temporary, path).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
        const raced = await lstat(path);
        if (!raced.isFile() || raced.isSymbolicLink())
          throw new Error(`Agent resource destination is a symlink or non-file: ${path}`);
      });
  } finally {
    await handle.close().catch(() => {});
    await rm(temporary, { force: true });
  }
}

export async function installEnvironmentResources(
  value: unknown,
  options: InstallOptions,
): Promise<void> {
  options.signal?.throwIfAborted();
  const decoded = await decodeCompiledAgentResources(value);
  if (decoded.some((file) => file.entry.placement !== 'environment'))
    throw new Error('Only environment resources can be installed here');
  if (!decoded.length) return;
  await safeDirectory(options.state);
  const marker = join(options.state, 'agent-resource-seeds.json');
  const markerStat = await inspect(marker);
  if (
    markerStat &&
    (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 128 * 1024)
  )
    throw new Error('Invalid agent resource seed state');
  const saved = markerStat
    ? JSON.parse(await readFile(marker, 'utf8'))
    : { projectId: options.projectId, sessionId: options.sessionId, targets: [] };
  if (
    saved.projectId !== options.projectId ||
    saved.sessionId !== options.sessionId ||
    !Array.isArray(saved.targets) ||
    saved.targets.some((target: unknown) => typeof target !== 'string')
  )
    throw new Error('Agent resource seed state identity mismatch');
  const seeded = new Set<string>(saved.targets);
  for (const { entry, bytes } of decoded) {
    options.signal?.throwIfAborted();
    const seed = entry.mode === 'seed';
    if (seed && seeded.has(entry.target!)) continue;
    const prefix = seed ? '/workspace/' : '/opt/kortix/helpers/';
    const root = resolve(seed ? options.workspace : options.helpers);
    const path = join(root, entry.target!.slice(prefix.length));
    await atomicFile(path, bytes, seed ? 0o644 : 0o444, !seed, options.signal);
    if (seed) {
      seeded.add(entry.target!);
      await atomicFile(
        marker,
        new TextEncoder().encode(
          JSON.stringify({
            projectId: options.projectId,
            sessionId: options.sessionId,
            targets: [...seeded],
          }),
        ),
        0o600,
        true,
        options.signal,
      );
    }
  }
}

export async function prepareEnvironmentResources(
  cfg: Config,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    fetchImpl?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
  } = {},
): Promise<void> {
  const sessionId = env.KORTIX_SESSION_ID;
  if (!cfg.apiUrl || !cfg.projectId || !cfg.sandboxToken || !sessionId || !env.KORTIX_AGENT_NAME)
    throw new Error('Environment resources require the authenticated session identity');
  const url = `${cfg.apiUrl.replace(/\/+$/, '')}/projects/${encodeURIComponent(cfg.projectId)}/sessions/${encodeURIComponent(sessionId)}/environment/resources`;
  const signal = AbortSignal.timeout(30_000);
  const response = await (options.fetchImpl ?? fetch)(url, {
    headers: { authorization: `Bearer ${cfg.sandboxToken}` },
    signal,
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Environment resources HTTP ${response.status}`);
  if (!response.body) throw new Error('Environment resource body is missing');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > 12 * 1024 * 1024) throw new Error('Environment resource response exceeds 12 MiB');
      chunks.push(result.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const manifest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (
    manifest.project_id !== cfg.projectId ||
    manifest.session_id !== sessionId ||
    manifest.agent_name !== env.KORTIX_AGENT_NAME ||
    typeof manifest.source_sha !== 'string' ||
    !/^[a-f0-9]{40}$/.test(manifest.source_sha)
  )
    throw new Error('Environment resource identity mismatch');
  await installEnvironmentResources(manifest.files, {
    workspace: cfg.workspace,
    helpers: '/opt/kortix/helpers',
    state: env.KORTIX_AGENT_STATE_DIR || '/opt/kortix/environment-runtime',
    projectId: cfg.projectId,
    sessionId,
    signal,
  });
}
