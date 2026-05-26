import { createHash, type Hash } from 'node:crypto';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';

export interface RuntimeArtifact {
  label: string;
  path: string;
}

export interface RuntimeArtifactFingerprintInput {
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
    await hashPath(hash, artifact.path, artifact.label);
  }

  return `kortix-runtime:${input.sandboxVersion}:artifacts:${hash.digest('hex')}`;
}

async function hashPath(hash: Hash, path: string, logicalPath: string): Promise<void> {
  const stats = await lstat(path);
  if (stats.isDirectory()) {
    hash.update(`dir\0${logicalPath}\0`);
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      await hashPath(hash, join(path, entry.name), `${logicalPath}/${entry.name}`);
    }
    return;
  }

  if (stats.isFile()) {
    hash.update(`file\0${logicalPath}\0${stats.size}\0`);
    hash.update(await readFile(path));
    hash.update('\0');
    return;
  }

  if (stats.isSymbolicLink()) {
    hash.update(`symlink\0${logicalPath}\0${await readlink(path)}\0`);
    return;
  }

  hash.update(`other\0${logicalPath}\0`);
}
