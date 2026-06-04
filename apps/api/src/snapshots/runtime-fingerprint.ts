import { createHash, type Hash } from 'node:crypto';
import { lstat, open, readdir, readlink } from 'node:fs/promises';
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
  const stats = await lstat(path);
  if (stats.isDirectory()) {
    hash.update(`dir\0${logicalPath}\0`);
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (excludeNames && excludeNames.includes(entry.name)) continue;
      await hashPath(hash, join(path, entry.name), `${logicalPath}/${entry.name}`, excludeNames);
    }
    return;
  }

  if (stats.isFile()) {
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
  }

  if (stats.isSymbolicLink()) {
    hash.update(`symlink\0${logicalPath}\0${await readlink(path)}\0`);
    return;
  }

  hash.update(`other\0${logicalPath}\0`);
}
