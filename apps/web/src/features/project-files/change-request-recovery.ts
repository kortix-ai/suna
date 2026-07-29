export interface ChangeRequestRecoveryTarget {
  crId: string;
  number: number;
  title: string;
  headRef: string;
  baseRef: string;
}

export interface ManifestIssue {
  path: string;
  message: string;
  severity: string;
  line?: number;
  column?: number;
}

export type ChangeRequestRecoveryBlocker =
  | {
      kind: 'merge_conflict';
      conflicts: string[];
      baseSha?: string;
      headSha?: string;
    }
  | {
      kind: 'manifest_invalid';
      issues: ManifestIssue[];
      manifestFilename: string;
    };

function manifestIssueLines(issues: ManifestIssue[]): string {
  return (
    issues
      .map((issue) => {
        const where = issue.line
          ? ` (line ${issue.line}${issue.column ? `, column ${issue.column}` : ''})`
          : '';
        return `- [${issue.severity}] ${issue.path}: ${issue.message}${where}`;
      })
      .join('\n') || '- The manifest failed validation against the canonical schema.'
  );
}

function conflictPathLines(conflicts: string[]): string {
  return conflicts.map((path) => `- ${path}`).join('\n') || '- Conflict paths were not reported.';
}

export function recoverySessionName(
  target: Pick<ChangeRequestRecoveryTarget, 'number'>,
  blocker: ChangeRequestRecoveryBlocker,
): string {
  return blocker.kind === 'merge_conflict'
    ? `Resolve conflicts for change #${target.number}`
    : `Fix proposed change #${target.number}`;
}

export function buildChangeRequestRecoveryPrompt(
  target: ChangeRequestRecoveryTarget,
  blocker: ChangeRequestRecoveryBlocker,
): string {
  if (blocker.kind === 'manifest_invalid') {
    return [
      `Change request #${target.number} ("${target.title}") cannot merge because ${blocker.manifestFilename} fails manifest validation.`,
      '',
      `The session starts from ${target.headRef}. The target branch is ${target.baseRef}.`,
      '',
      'Manifest validation errors:',
      manifestIssueLines(blocker.issues),
      '',
      'Complete these steps:',
      `1. Open ${blocker.manifestFilename} and fix every validation error.`,
      '2. Run the manifest validation and the relevant project checks.',
      '3. Commit and push the fix from this session branch.',
      `4. Open a replacement change request into ${target.baseRef}.`,
      '5. Apply the replacement change request after all checks pass if your permissions allow it.',
      `6. Report whether change request #${target.number} remains open or was superseded.`,
    ].join('\n');
  }

  return [
    `Change request #${target.number} ("${target.title}") cannot merge because ${target.headRef} conflicts with the latest ${target.baseRef}.`,
    '',
    `The session starts from ${target.headRef}. Preserve the intended changes from both branches.`,
    blocker.headSha ? `Head SHA: ${blocker.headSha}` : null,
    blocker.baseSha ? `Base SHA: ${blocker.baseSha}` : null,
    '',
    'Conflicting files:',
    conflictPathLines(blocker.conflicts),
    '',
    'Complete these steps:',
    `1. Fetch the latest origin/${target.baseRef}.`,
    `2. Merge origin/${target.baseRef} into the current session branch.`,
    '3. Resolve every conflict. Remove all conflict markers.',
    '4. Run the relevant project checks.',
    '5. Commit and push the resolved branch.',
    `6. Open a replacement change request into ${target.baseRef}.`,
    '7. Apply the replacement change request after all checks pass if your permissions allow it.',
    `8. Report whether change request #${target.number} remains open or was superseded.`,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}
