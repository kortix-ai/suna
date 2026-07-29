import { describe, expect, test } from 'bun:test';

import {
  buildChangeRequestRecoveryPrompt,
  recoverySessionName,
  type ChangeRequestRecoveryTarget,
} from './change-request-recovery';

const target: ChangeRequestRecoveryTarget = {
  crId: 'cr-159',
  number: 159,
  title: 'support: log health sweep',
  headRef: 'session-branch',
  baseRef: 'main',
};

describe('change request recovery', () => {
  test('builds an actionable merge-conflict prompt from the blocked change', () => {
    const blocker = {
      kind: 'merge_conflict' as const,
      conflicts: ['.kortix/memory/plain-support-log.md', 'README.md'],
      baseSha: 'base-sha',
      headSha: 'head-sha',
    };
    const prompt = buildChangeRequestRecoveryPrompt(target, blocker);

    expect(recoverySessionName(target, blocker)).toBe('Resolve conflicts for change #159');
    expect(prompt).toContain('session-branch conflicts with the latest main');
    expect(prompt).toContain('- .kortix/memory/plain-support-log.md');
    expect(prompt).toContain('Merge origin/main into the current session branch');
    expect(prompt).toContain('Open a replacement change request into main');
    expect(prompt).toContain('Apply the replacement change request');
  });

  test('keeps manifest recovery on the same session-start contract', () => {
    const blocker = {
      kind: 'manifest_invalid' as const,
      manifestFilename: 'kortix.yaml',
      issues: [
        {
          path: 'agents.support.model',
          severity: 'error',
          message: 'Unknown model',
          line: 12,
          column: 4,
        },
      ],
    };
    const prompt = buildChangeRequestRecoveryPrompt(target, blocker);

    expect(recoverySessionName(target, blocker)).toBe('Fix proposed change #159');
    expect(prompt).toContain('- [error] agents.support.model: Unknown model (line 12, column 4)');
    expect(prompt).toContain('Open a replacement change request into main');
  });
});
