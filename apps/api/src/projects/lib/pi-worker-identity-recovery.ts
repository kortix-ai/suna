import { piWorkerRuntimeIdentityFromSessionMetadata, type PiWorkerRuntimeIdentity } from './session-sandbox-metadata';

export const PI_ARTIFACT_IDENTITY_SCRIPT = String.raw`
const fs = require('node:fs');
const fd = fs.openSync(process.argv[1], 'r');
try {
  const bytes = Buffer.alloc(2 * 1024 * 1024);
  const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
  const line = bytes.subarray(0, size).toString('utf8').split('\n')[1];
  const prefix = '// kortix-manifest-base64url:';
  if (!line?.startsWith(prefix)) throw new Error('Pi artifact manifest is missing');
  const manifest = JSON.parse(Buffer.from(line.slice(prefix.length), 'base64url').toString('utf8'));
  const {project_id, ref, source_sha, engine, format} = manifest;
  process.stdout.write(JSON.stringify({project_id, ref, source_sha, engine, format}));
} finally { fs.closeSync(fd); }
`;

export function isLegacyPiWorkerMetadata(metadata: Record<string, unknown> | null | undefined): boolean {
  return metadata?.sandbox_slug === 'pi-worker' &&
    metadata.pi_worker_boot === undefined &&
    metadata.pi_worker_ref === undefined &&
    metadata.pi_worker_sha === undefined;
}

export async function recoverLegacyPiWorkerIdentity(input: {
  projectId: string;
  metadata: Record<string, unknown> | null | undefined;
  sandbox: { provider: string; externalId: string | null; metadata: Record<string, unknown> | null } | null;
  readArtifact: () => Promise<unknown>;
}): Promise<PiWorkerRuntimeIdentity | null> {
  if (!isLegacyPiWorkerMetadata(input.metadata) || !input.sandbox?.externalId ||
      input.sandbox.provider !== 'daytona' || input.sandbox.metadata?.pi_worker_boot !== true) return null;
  const raw = await input.readArtifact();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const manifest = raw as Record<string, unknown>;
  if (manifest.project_id !== input.projectId || manifest.engine !== 'pi' ||
      manifest.format !== 'kortix.compiled-pi-runtime.v1') return null;
  return piWorkerRuntimeIdentityFromSessionMetadata({
    sandbox_slug: 'pi-worker', pi_worker_boot: true,
    pi_worker_ref: manifest.ref, pi_worker_sha: manifest.source_sha,
  });
}
