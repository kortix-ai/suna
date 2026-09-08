import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { t, x } from 'tar';

interface LockedPackage {
  version: string;
  resolved: string;
  integrity: string;
  link?: boolean;
  dev?: boolean;
}
interface Input {
  packageJson: string;
  packageLock: string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}
const MiB = 1024 * 1024;
const packagePath = /^(?:node_modules\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/|$))+$/;

export async function preparePiDependencies(input: Input) {
  const pkg = JSON.parse(input.packageJson);
  const lock = JSON.parse(input.packageLock);
  if (
    !pkg ||
    typeof pkg !== 'object' ||
    Array.isArray(pkg) ||
    lock?.lockfileVersion !== 3 ||
    !lock.packages?.['']
  )
    throw new Error('Pi dependencies require package.json and package-lock.json version 3');
  for (const field of ['dependencies', 'optionalDependencies'])
    if (!isDeepStrictEqual(pkg[field] ?? {}, lock.packages[''][field] ?? {}))
      throw new Error(`Pi dependency lock does not match package.json ${field}`);
  const entries = Object.entries(lock.packages).filter(
    ([path, value]) => path && !(value as LockedPackage)?.dev,
  ) as Array<[string, LockedPackage]>;
  if (entries.length > 128) throw new Error('Pi dependencies exceed 128 locked packages');
  for (const [path, record] of entries) {
    if (
      !packagePath.test(path) ||
      path.endsWith('/') ||
      !record ||
      record.link ||
      typeof record.version !== 'string' ||
      !record.version
    )
      throw new Error('Pi dependency lock contains an unsupported package path or link');
    let url: URL;
    try {
      url = new URL(record.resolved);
    } catch {
      throw new Error('Pi dependency source must be a public npm registry archive');
    }
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'registry.npmjs.org' ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.endsWith('.tgz')
    )
      throw new Error('Pi dependency source must be a public npm registry archive');
    if (
      typeof record.integrity !== 'string' ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/.test(record.integrity)
    )
      throw new Error('Pi dependency requires SHA-512 integrity');
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kortix-pi-deps-')));
  const cleanup = () => rm(root, { recursive: true, force: true });
  const abort = new AbortController();
  const deadline = AbortSignal.timeout(90000);
  const signal = AbortSignal.any([abort.signal, deadline]);
  let compressedBytes = 0;
  let expandedBytes = 0;
  let fileCount = 0;
  let next = 0;
  async function install() {
    while (next < entries.length) {
      signal.throwIfAborted();
      const [path, record] = entries[next++]!;
      const response = await (input.fetch ?? fetch)(record.resolved, { redirect: 'error', signal });
      if (!response.ok || !response.body)
        throw new Error(`Pi dependency download returned ${response.status}`);
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          compressedBytes += value.byteLength;
          if (size > 8 * MiB || compressedBytes > 64 * MiB)
            throw new Error('Pi dependency archives exceed the download size limit');
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const bytes = Buffer.concat(chunks);
      const digest = createHash('sha512').update(bytes).digest();
      const expected = Buffer.from(record.integrity.slice(7), 'base64');
      if (expected.length !== digest.length || !timingSafeEqual(digest, expected))
        throw new Error(`Pi dependency integrity mismatch for ${path}`);
      const tar = gunzipSync(bytes, { maxOutputLength: 32 * MiB });
      expandedBytes += tar.byteLength;
      if (expandedBytes > 128 * MiB) throw new Error('Pi dependencies exceed 128 MiB unpacked');
      const archive = join(root, crypto.randomUUID() + '.tar');
      await writeFile(archive, tar, { mode: 0o600 });
      t({
        file: archive,
        sync: true,
        strict: true,
        onReadEntry(entry) {
          fileCount++;
          const parts = entry.path.replace(/\/$/, '').split('/');
          if (
            fileCount > 20000 ||
            entry.size > 8 * MiB ||
            !['File', 'Directory'].includes(entry.type) ||
            parts[0] !== 'package' ||
            parts.some(
              (part) =>
                !part ||
                part === '.' ||
                part === '..' ||
                part === 'node_modules' ||
                part.includes('\\') ||
                part.includes('\0'),
            )
          )
            throw new Error(
              'Pi dependency archive contains unsupported paths, links, or oversized files',
            );
        },
      });
      const destination = join(root, path);
      await mkdir(destination, { recursive: true, mode: 0o700 });
      x({
        file: archive,
        cwd: destination,
        strip: 1,
        sync: true,
        strict: true,
        noChmod: true,
        preserveOwner: false,
        filter: (_path, entry) =>
          'type' in entry && (entry.type === 'File' || entry.type === 'Directory'),
      });
      await rm(archive);
    }
  }
  try {
    const outcomes = await Promise.allSettled(
      Array.from({ length: Math.min(4, entries.length) }, () =>
        install().catch((error) => {
          abort.abort(error);
          throw error;
        }),
      ),
    );
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
    return {
      root,
      cleanup,
      lockSha256: createHash('sha256').update(input.packageLock).digest('hex'),
    };
  } catch (error) {
    abort.abort(error);
    await cleanup();
    throw error;
  }
}
