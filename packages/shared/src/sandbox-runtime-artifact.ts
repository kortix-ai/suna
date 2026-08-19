import { type Hash, createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { type FileHandle, lstat, open, readdir, readlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface RuntimeArtifact {
  label: string;
  path: string;
  /**
   * Directory entry names to skip when walking this artifact.
   * This excludes generated state that does not enter the runtime artifact.
   */
  excludeNames?: readonly string[];
}

export interface RuntimeArtifactFingerprintInput {
  sandboxVersion: string;
  opencodeVersion: string;
  artifacts: RuntimeArtifact[];
}

/**
 * Files that can change `kortix connectors` inside a sandbox.
 *
 * Paths are relative to `apps/cli`. The snapshot identity and the compiled
 * binary attestation both use this one list.
 */
export const CLI_CONNECTOR_RUNTIME_FILES = [
  'src/connector-gateway',
  'src/commands/connector-gateway.ts',
  'src/api/auth.ts',
  'src/api/client.ts',
  'src/api/config.ts',
  // The CLI's one seam onto `@kortix/sdk`. `src/api/client.ts` imports it, so
  // every in-sandbox `kortix connectors` call resolves its transport through this
  // file — a change to it changes the connector's behavior and MUST move the
  // snapshot's runtime identity. Left out, an edit here shipped a stale binary
  // under an unchanged snapshot name (apps/api/src/snapshots/__tests__/cli-connector-closure.test.ts
  // is the guard that catches it).
  'src/api/sdk.ts',
  'src/api/sandbox-env.ts',
  // `src/api/client.ts` records what the acting token resolves to from every
  // `/accounts/me` response, so this file is compiled into the connector
  // binary. It deliberately declares its own `AccountsMeBody` instead of
  // importing `src/api/types.ts` — that file changes with every API type
  // addition, and hashing it would re-mint every project's runtime identity on
  // edits that cannot affect the connector.
  'src/api/token-identity.ts',
  'src/project-link.ts',
] as const;

const CLI_RUNTIME_EXCLUDES = ['node_modules', '.bin', 'dist', '.turbo', '.cache'] as const;

export function cliConnectorRuntimeArtifacts(
  cliRoot: string,
  sdkRoot = resolve(cliRoot, '../../packages/sdk'),
): RuntimeArtifact[] {
  return [
    ...CLI_CONNECTOR_RUNTIME_FILES.map((relativePath) => ({
      // Preserve the existing snapshot-fingerprint labels. The paths moved
      // from an apps/cli/src-relative list to this apps/cli-relative list.
      label: `kortix-cli-${relativePath.replace(/^src\//, '')}`,
      path: join(cliRoot, relativePath),
      excludeNames: CLI_RUNTIME_EXCLUDES,
    })),
    { label: 'kortix-cli-pkg', path: join(cliRoot, 'package.json') },
    {
      label: 'kortix-sdk-src',
      path: join(sdkRoot, 'src'),
      excludeNames: CLI_RUNTIME_EXCLUDES,
    },
    { label: 'kortix-sdk-pkg', path: join(sdkRoot, 'package.json') },
  ];
}

/**
 * Deterministic digest of the source that defines the in-sandbox Connector CLI.
 *
 * The CLI build writes this digest beside the compiled binary. The snapshot
 * builder recomputes it before upload and rejects a stale binary.
 */
export function buildCliConnectorSourceDigest(
  cliRoot: string,
  sdkRoot?: string,
): Promise<string> {
  return buildArtifactContentDigest(cliConnectorRuntimeArtifacts(cliRoot, sdkRoot));
}

/**
 * SHA-256 digest of one compiled runtime artifact.
 */
export async function buildFileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

/**
 * Deterministic content digest for a labeled artifact set.
 */
export async function buildArtifactContentDigest(artifacts: RuntimeArtifact[]): Promise<string> {
  const hash = createHash('sha256');
  await hashArtifacts(hash, artifacts);
  return hash.digest('hex');
}

export async function buildRuntimeArtifactFingerprint(
  input: RuntimeArtifactFingerprintInput,
): Promise<string> {
  const hash = createHash('sha256');
  hash.update(`sandbox_version\0${input.sandboxVersion}\0`);
  hash.update(`opencode_version\0${input.opencodeVersion}\0`);
  await hashArtifacts(hash, input.artifacts);
  return `kortix-runtime:${input.sandboxVersion}:artifacts:${hash.digest('hex')}`;
}

async function hashArtifacts(hash: Hash, artifacts: RuntimeArtifact[]): Promise<void> {
  for (const artifact of [...artifacts].sort((a, b) => a.label.localeCompare(b.label))) {
    await hashPath(hash, artifact.path, artifact.label, artifact.excludeNames);
  }
}

/**
 * True for a directory entry that holds test sources only.
 */
function isTestEntry(name: string): boolean {
  return name === '__tests__' || /\.(test|spec)\.[cm]?tsx?$/.test(name);
}

async function hashPath(
  hash: Hash,
  path: string,
  logicalPath: string,
  excludeNames?: readonly string[],
): Promise<void> {
  if (await hashFileIfRegular(hash, path, logicalPath)) return;

  const stats = await lstat(path);
  if (stats.isDirectory()) {
    hash.update(`dir\0${logicalPath}\0`);
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (excludeNames?.includes(entry.name)) continue;
      if (isTestEntry(entry.name)) continue;
      await hashPath(hash, join(path, entry.name), `${logicalPath}/${entry.name}`, excludeNames);
    }
    return;
  }

  if (stats.isSymbolicLink()) {
    hash.update(`symlink\0${logicalPath}\0${await readlink(path)}\0`);
    return;
  }

  hash.update(`other\0${logicalPath}\0`);
}

async function hashFileIfRegular(hash: Hash, path: string, logicalPath: string): Promise<boolean> {
  let file: FileHandle;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return false;
  }

  try {
    const stats = await file.stat();
    if (!stats.isFile()) return false;
    const contents = await file.readFile();
    hash.update(`file\0${logicalPath}\0${stats.size}\0`);
    hash.update(contents);
    hash.update('\0');
    return true;
  } finally {
    await file.close();
  }
}
