import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(import.meta.dir, path), 'utf8');

describe('connector approval review contract', () => {
  test('the session header links to parameter review and cannot resolve directly', () => {
    const source = read('../session/header/session-pending-approvals-indicator.tsx');

    expect(source).toContain('Review parameters');
    expect(source).toContain('approval_url');
    expect(source).not.toContain('useResolveApproval');
    expect(source).not.toContain("decision: 'approve'");
    expect(source).not.toContain("decision: 'deny'");
    expect(source).toContain('<Badge');
    expect(source).toContain('text-kortix-orange');
    expect(source).not.toContain('text-amber-');
    expect(source).not.toContain('bg-amber-');
    expect(source).not.toContain('text-[');
    expect(source).not.toContain('h-7');
  });

  test('the in-session card reviews the same parameters inline and keeps the link', () => {
    const source = read('../session/session-approval-prompt.tsx');

    expect(source).toContain('ApprovalParameters');
    expect(source).toContain('ApprovalDecisionActions');
    expect(source).toContain('approval_url');
    expect(source).not.toContain('Allow for session');
    expect(source).not.toContain('Allow everything');
    expect(source).not.toContain('Always allow');
    expect(source).toContain('text-kortix-orange');
    expect(source).not.toContain('text-amber-');
    expect(source).not.toContain('bg-amber-');
  });

  test('Review Center uses the shared full-parameter component', () => {
    const modal = read('./review-detail-modal.tsx');
    const center = read('./review-center.tsx');

    expect(modal).toContain('<ApprovalRequest');
    expect(modal).toContain('argsPreview: adaptedAction.rawArgsPreview');
    expect(modal).not.toContain('Always allow this');
    expect(center).not.toContain('Approve all safe');
    expect(center).toContain("item.kind !== 'approval'");
  });
});
