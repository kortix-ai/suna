import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const AUDIT_V2_MIGRATION = '20260807221200000_centralized_audit_v2.sql';
const AUDIT_V2_SHA256 = '769b863ef0b62c4693e232cf102757ce3c3ee904f0f44c9aea450901a56e07f9';
const AUDIT_V2_TIMEOUT = "SET statement_timeout = '120s';";
const AUDIT_V2_RUNTIME_TIMEOUT = "SET statement_timeout = '30min';";

interface RuntimeOverrideOptions {
  /** Test seam. Production always uses the committed migration checksum above. */
  expectedSha256?: string;
}

export interface MigrationRuntimeDirectory {
  path: string;
  appliedOverrides: string[];
  cleanup: () => void;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Materialize the immutable migration set used by node-pg-migrate.
 *
 * The first audit-v2 deploy proved that its 120-second statement timeout is
 * lower than the real legacy audit backfill duration. The migration rolled
 * back before any hosted environment recorded it. Migration files are
 * immutable after merge, so the runner applies one checksum-guarded runtime
 * override instead of editing the committed SQL. Only the timeout changes,
 * and the replacement remains bounded at 30 minutes.
 */
export function materializeMigrationRuntimeDirectory(
  sourceDirectory: string,
  options: RuntimeOverrideOptions = {},
): MigrationRuntimeDirectory {
  const sourceMigration = join(sourceDirectory, AUDIT_V2_MIGRATION);
  if (!existsSync(sourceMigration)) {
    return { path: sourceDirectory, appliedOverrides: [], cleanup: () => {} };
  }

  const source = readFileSync(sourceMigration, 'utf8');
  const expectedSha256 = options.expectedSha256 ?? AUDIT_V2_SHA256;
  const actualSha256 = sha256(source);
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `${AUDIT_V2_MIGRATION} checksum mismatch: expected ${expectedSha256}, received ${actualSha256}`,
    );
  }

  const occurrenceCount = source.split(AUDIT_V2_TIMEOUT).length - 1;
  if (occurrenceCount !== 1) {
    throw new Error(
      `${AUDIT_V2_MIGRATION} expected exactly one ${JSON.stringify(AUDIT_V2_TIMEOUT)} statement; found ${occurrenceCount}`,
    );
  }

  const runtimeRoot = mkdtempSync(join(tmpdir(), 'kortix-migrations-'));
  const runtimeDirectory = join(runtimeRoot, 'migrations');
  try {
    cpSync(sourceDirectory, runtimeDirectory, { recursive: true });
    writeFileSync(
      join(runtimeDirectory, AUDIT_V2_MIGRATION),
      source.replace(AUDIT_V2_TIMEOUT, AUDIT_V2_RUNTIME_TIMEOUT),
    );
  } catch (error) {
    rmSync(runtimeRoot, { force: true, recursive: true });
    throw error;
  }

  let cleaned = false;
  return {
    path: runtimeDirectory,
    appliedOverrides: [
      `${AUDIT_V2_MIGRATION}: statement_timeout 120s -> 30min (${AUDIT_V2_SHA256})`,
    ],
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      rmSync(runtimeRoot, { force: true, recursive: true });
    },
  };
}
