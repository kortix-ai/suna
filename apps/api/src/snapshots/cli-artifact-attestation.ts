import { readFile } from 'node:fs/promises';
import {
  buildCliExecutorSourceDigest,
  buildFileSha256,
} from '@kortix/shared/sandbox-runtime-artifact';

const SHA256_HEX = /^[0-9a-f]{64}$/;
const LINUX_BUN_TARGET = /^bun-linux-(x64|arm64)$/;

interface CliArtifactAttestation {
  schema_version: 1;
  source_sha256: string;
  binary_sha256: string;
  target: string;
}

function parseAttestation(path: string, raw: string): CliArtifactAttestation {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(
      `Invalid CLI artifact attestation at ${path}. Run \`bun run build\` in apps/cli before building a sandbox snapshot.`,
    );
  }
  if (
    !value
    || typeof value !== 'object'
    || (value as Record<string, unknown>).schema_version !== 1
    || !SHA256_HEX.test(String((value as Record<string, unknown>).source_sha256 ?? ''))
    || !SHA256_HEX.test(String((value as Record<string, unknown>).binary_sha256 ?? ''))
    || !LINUX_BUN_TARGET.test(String((value as Record<string, unknown>).target ?? ''))
  ) {
    throw new Error(
      `Invalid CLI artifact attestation at ${path}. Run \`bun run build\` in apps/cli before building a sandbox snapshot.`,
    );
  }
  return value as CliArtifactAttestation;
}

/**
 * Prove that the compiled CLI belongs to the source used by snapshot identity.
 *
 * The compiled binary is not deterministic across Bun builds. The snapshot
 * identity therefore hashes source. The CLI build records the source digest,
 * binary digest, and Linux compile target. Any mismatch fails before upload.
 */
export async function assertCliArtifactAttested(input: {
  cliRoot: string;
  binaryPath: string;
  attestationPath: string;
}): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(input.attestationPath, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Required CLI artifact attestation missing: ${input.attestationPath} (${reason}). Run \`bun run build\` in apps/cli before building a sandbox snapshot.`,
    );
  }

  const recorded = parseAttestation(input.attestationPath, raw);
  const current = await buildCliExecutorSourceDigest(input.cliRoot);
  if (recorded.source_sha256 !== current) {
    throw new Error(
      `Compiled sandbox CLI is stale: attested source ${recorded.source_sha256}, current source ${current}. Run \`bun run build\` in apps/cli before building a sandbox snapshot.`,
    );
  }
  const binarySha256 = await buildFileSha256(input.binaryPath);
  if (recorded.binary_sha256 !== binarySha256) {
    throw new Error(
      `Compiled sandbox CLI does not match its attestation: attested binary ${recorded.binary_sha256}, current binary ${binarySha256}. Run \`bun run build\` in apps/cli before building a sandbox snapshot.`,
    );
  }
  return current;
}
