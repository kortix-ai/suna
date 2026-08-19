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
const REMOVE_LOCAL_DOCKER_MIGRATION = '20260807165721291_remove_local_docker_provider.sql';
const REMOVE_LOCAL_DOCKER_SHA256 = 'e0cfc4b8df7598ee3dfb485606d264fa5b915fd03871873019bd0d005b9b120b';
const REMOVE_LOCAL_DOCKER_INSERTION_POINT = `DROP TRIGGER IF EXISTS trg_session_sandbox_identity_immutable
  ON kortix.session_sandboxes;--> statement-breakpoint

`;
const REMOVE_LOCAL_DOCKER_RUNTIME_DROP = `-- Runtime correction: historical databases can retain this compatibility
-- view. It depends on project_sessions.sandbox_provider and blocks the enum
-- rewrite in this immutable migration.
DROP VIEW IF EXISTS kortix.workspace_sessions;--> statement-breakpoint

`;

interface RuntimeOverrideOptions {
  /** Test seam. Production always uses the committed migration checksum above. */
  expectedSha256?: string;
  removeLocalDockerExpectedSha256?: string;
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
 * Migration files remain immutable after merge. A runtime correction must
 * match the exact committed checksum and alter only the approved statement.
 */
export function materializeMigrationRuntimeDirectory(
  sourceDirectory: string,
  options: RuntimeOverrideOptions = {},
): MigrationRuntimeDirectory {
  const auditPath = join(sourceDirectory, AUDIT_V2_MIGRATION);
  const removeLocalDockerPath = join(sourceDirectory, REMOVE_LOCAL_DOCKER_MIGRATION);
  const hasAuditOverride = existsSync(auditPath);
  const hasRemoveLocalDockerOverride = existsSync(removeLocalDockerPath);
  if (!hasAuditOverride && !hasRemoveLocalDockerOverride) {
    return { path: sourceDirectory, appliedOverrides: [], cleanup: () => {} };
  }

  const auditSource = hasAuditOverride ? readFileSync(auditPath, 'utf8') : null;
  const removeLocalDockerSource = hasRemoveLocalDockerOverride
    ? readFileSync(removeLocalDockerPath, 'utf8')
    : null;
  if (auditSource) {
    const expectedSha256 = options.expectedSha256 ?? AUDIT_V2_SHA256;
    const actualSha256 = sha256(auditSource);
    if (actualSha256 !== expectedSha256) {
      throw new Error(
        `${AUDIT_V2_MIGRATION} checksum mismatch: expected ${expectedSha256}, received ${actualSha256}`,
      );
    }
    const occurrenceCount = auditSource.split(AUDIT_V2_TIMEOUT).length - 1;
    if (occurrenceCount !== 1) {
      throw new Error(
        `${AUDIT_V2_MIGRATION} expected exactly one ${JSON.stringify(AUDIT_V2_TIMEOUT)} statement; found ${occurrenceCount}`,
      );
    }
  }
  if (removeLocalDockerSource) {
    const expectedSha256 = options.removeLocalDockerExpectedSha256 ?? REMOVE_LOCAL_DOCKER_SHA256;
    const actualSha256 = sha256(removeLocalDockerSource);
    if (actualSha256 !== expectedSha256) {
      throw new Error(
        `${REMOVE_LOCAL_DOCKER_MIGRATION} checksum mismatch: expected ${expectedSha256}, received ${actualSha256}`,
      );
    }
    const occurrenceCount = removeLocalDockerSource.split(REMOVE_LOCAL_DOCKER_INSERTION_POINT).length - 1;
    if (occurrenceCount !== 1) {
      throw new Error(
        `${REMOVE_LOCAL_DOCKER_MIGRATION} expected exactly one trigger insertion point; found ${occurrenceCount}`,
      );
    }
  }

  const runtimeRoot = mkdtempSync(join(tmpdir(), 'kortix-migrations-'));
  const runtimeDirectory = join(runtimeRoot, 'migrations');
  const appliedOverrides: string[] = [];
  try {
    cpSync(sourceDirectory, runtimeDirectory, { recursive: true });
    if (auditSource) {
      writeFileSync(
        join(runtimeDirectory, AUDIT_V2_MIGRATION),
        auditSource.replace(AUDIT_V2_TIMEOUT, AUDIT_V2_RUNTIME_TIMEOUT),
      );
      appliedOverrides.push(
        `${AUDIT_V2_MIGRATION}: statement_timeout 120s -> 30min (${AUDIT_V2_SHA256})`,
      );
    }
    if (removeLocalDockerSource) {
      writeFileSync(
        join(runtimeDirectory, REMOVE_LOCAL_DOCKER_MIGRATION),
        removeLocalDockerSource.replace(
          REMOVE_LOCAL_DOCKER_INSERTION_POINT,
          REMOVE_LOCAL_DOCKER_INSERTION_POINT + REMOVE_LOCAL_DOCKER_RUNTIME_DROP,
        ),
      );
      appliedOverrides.push(
        `${REMOVE_LOCAL_DOCKER_MIGRATION}: drop historical workspace_sessions view (${REMOVE_LOCAL_DOCKER_SHA256})`,
      );
    }
  } catch (error) {
    rmSync(runtimeRoot, { force: true, recursive: true });
    throw error;
  }

  let cleaned = false;
  return {
    path: runtimeDirectory,
    appliedOverrides,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      rmSync(runtimeRoot, { force: true, recursive: true });
    },
  };
}
