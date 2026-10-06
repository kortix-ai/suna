#!/usr/bin/env bun
/**
 * Audit: every remote GitHub Actions `uses:` ref inside a credential-holding
 * workflow must be pinned to a full 40-hex commit SHA (`<sha> # v<tag>`, the
 * convention already used in `terraform-apply.yml` and `deploy-preview.yml`).
 *
 * A workflow is credential-holding when it grants `id-token: write` (the OIDC
 * gate to AWS via `.github/actions/aws-env`) or reads secrets through that
 * action. A mutable tag on any of its actions turns a tag takeover into code
 * execution inside a job that holds cloud credentials (CWE-829).
 *
 * Exit 0 = green (no violations). Exit 1 = at least one violation, each listed
 * as `file:line uses:` value.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** A step `uses:` line: optional list dash, the value, optional trailing comment. */
const USES_LINE = /^\s*(?:-\s+)?uses:\s*(\S+)(?:\s+#.*)?$/;
/** A `permissions` entry granting workflow identity access. */
const ID_TOKEN_WRITE = /^\s*id-token:\s*['"]?write['"]?\s*(?:#.*)?$/;

type Violation = { file: string; line: number; uses: string };

type AuditResult = {
  workflows: number;
  remoteRefs: number;
  pinned: number;
  unpinned: number;
  credentialWorkflowViolations: number;
  violations: Violation[];
};

/** True when the ref after the last `@` is a full 40-character lowercase hex commit SHA. */
function isShaPinned(uses: string): boolean {
  return /^[0-9a-f]{40}$/.test(uses.slice(uses.lastIndexOf('@') + 1));
}

/** Local composite actions (`./…`) and container images (`docker://…`) are out of scope. */
function isRemoteAction(uses: string): boolean {
  return !uses.startsWith('./') && !uses.startsWith('docker://');
}

export function auditWorkflows(workflowsDir: string): AuditResult {
  const files = readdirSync(workflowsDir, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && (entry.name.endsWith('.yml') || entry.name.endsWith('.yaml')),
    )
    .map((entry) => entry.name)
    .sort();
  const result: AuditResult = {
    workflows: files.length,
    remoteRefs: 0,
    pinned: 0,
    unpinned: 0,
    credentialWorkflowViolations: 0,
    violations: [],
  };
  for (const name of files) {
    const lines = readFileSync(join(workflowsDir, name), 'utf8').split('\n');
    const credentialHolding = lines.some((l) => ID_TOKEN_WRITE.test(l) || l.includes('aws-env'));
    lines.forEach((line, index) => {
      const match = USES_LINE.exec(line);
      if (!match) return;
      const uses = match[1];
      if (!isRemoteAction(uses)) return;
      result.remoteRefs += 1;
      if (isShaPinned(uses)) {
        result.pinned += 1;
        return;
      }
      result.unpinned += 1;
      if (credentialHolding) {
        result.credentialWorkflowViolations += 1;
        result.violations.push({ file: name, line: index + 1, uses });
      }
    });
  }
  return result;
}

function main(): void {
  const dir = join(import.meta.dir, '..', 'workflows');
  const result = auditWorkflows(dir);
  for (const v of result.violations) {
    console.error(`${v.file}:${v.line}: ${v.uses}`);
  }
  console.log(
    `workflows=${result.workflows} remote_refs=${result.remoteRefs} pinned=${result.pinned} ` +
      `unpinned=${result.unpinned} credentialWorkflowViolations=${result.credentialWorkflowViolations}`,
  );
  process.exit(result.violations.length === 0 ? 0 : 1);
}

if (import.meta.main) main();
