import { createHash, type Hash } from 'node:crypto';
import { open, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';

interface RuntimeArtifact {
  label: string;
  path: string;
  /**
   * Directory entry names to skip when walking this artifact. Lets callers
   * exclude generated/install state like `node_modules` (pnpm symlink targets
   * can shift across installs even when the source hasn't changed, which would
   * otherwise flip the fingerprint and force every project to rebuild).
   */
  excludeNames?: readonly string[];
}

interface RuntimeArtifactFingerprintInput {
  sandboxVersion: string;
  opencodeVersion: string;
  artifacts: RuntimeArtifact[];
}

export async function buildRuntimeArtifactFingerprint(
  input: RuntimeArtifactFingerprintInput,
): Promise<string> {
  const hash = createHash('sha256');
  hash.update(`sandbox_version\0${input.sandboxVersion}\0`);
  hash.update(`opencode_version\0${input.opencodeVersion}\0`);

  for (const artifact of [...input.artifacts].sort((a, b) => a.label.localeCompare(b.label))) {
    await hashPath(hash, artifact.path, artifact.label, artifact.excludeNames);
  }

  return `kortix-runtime:${input.sandboxVersion}:artifacts:${hash.digest('hex')}`;
}

async function hashPath(
  hash: Hash,
  path: string,
  logicalPath: string,
  excludeNames?: readonly string[],
): Promise<void> {
  try {
    hash.update(`symlink\0${logicalPath}\0${await readlink(path)}\0`);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOENT') throw err;
  }

  try {
    const entries = await readdir(path, { withFileTypes: true });
    hash.update(`dir\0${logicalPath}\0`);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (excludeNames && excludeNames.includes(entry.name)) continue;
      await hashPath(hash, join(path, entry.name), `${logicalPath}/${entry.name}`, excludeNames);
    }
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOTDIR' && code !== 'ENOENT') throw err;
  }

  try {
    const file = await open(path, 'r');
    try {
      const fileStats = await file.stat();
      if (!fileStats.isFile()) {
        hash.update(`other\0${logicalPath}\0`);
        return;
      }
      const content = await file.readFile();
      hash.update(`file\0${logicalPath}\0${content.length}\0`);
      hash.update(content);
      hash.update('\0');
    } finally {
      await file.close();
    }
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'EISDIR' && code !== 'ENXIO') throw err;
  }

  hash.update(`other\0${logicalPath}\0`);
}
