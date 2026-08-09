import { describe, expect, test } from 'bun:test';
import { evaluateTaskCompletion } from './task-completion-policy';

const requirement = {
  id: 'tests',
  kind: 'command' as const,
  description: 'Focused tests pass.',
  required: true,
};

const evidence = {
  evidenceId: 'evidence-1',
  requirementId: 'tests',
  kind: 'command' as const,
  contractRevision: 2,
  candidateDigest: 'sha256:abc',
  state: 'passed' as const,
};

describe('evaluateTaskCompletion', () => {
  test('requires human review after every required condition passes', () => {
    expect(
      evaluateTaskCompletion({
        contractRevision: 2,
        requirements: [requirement],
        evidence: [evidence],
        openBlockerCount: 0,
        reviewPolicy: { mode: 'auto' },
        humanReviewSatisfied: false,
        candidateDigest: 'sha256:abc',
      }),
    ).toEqual({
      ok: false,
      unmet: [{ code: 'HUMAN_REVIEW_REQUIRED' }],
    });
  });

  test('accepts fresh passed evidence only after a human approves it', () => {
    expect(
      evaluateTaskCompletion({
        contractRevision: 2,
        requirements: [requirement],
        evidence: [evidence],
        openBlockerCount: 0,
        reviewPolicy: { mode: 'auto' },
        humanReviewSatisfied: true,
        candidateDigest: 'sha256:abc',
      }),
    ).toEqual({ ok: true });
  });

  test('returns every unmet server-owned completion condition', () => {
    expect(
      evaluateTaskCompletion({
        contractRevision: 3,
        requirements: [requirement],
        evidence: [evidence],
        openBlockerCount: 1,
        reviewPolicy: { mode: 'human' },
        humanReviewSatisfied: false,
        candidateDigest: 'sha256:def',
      }),
    ).toEqual({
      ok: false,
      unmet: [
        { code: 'OPEN_BLOCKERS', count: 1 },
        { code: 'REQUIRED_CHECK_MISSING', requirement_id: 'tests' },
        { code: 'HUMAN_REVIEW_REQUIRED' },
      ],
    });
  });

  test('rejects failed evidence and evidence for another candidate', () => {
    expect(
      evaluateTaskCompletion({
        contractRevision: 2,
        requirements: [requirement],
        evidence: [
          { ...evidence, state: 'failed' },
          { ...evidence, evidenceId: 'evidence-2', candidateDigest: 'sha256:old' },
        ],
        openBlockerCount: 0,
        reviewPolicy: { mode: 'auto' },
        humanReviewSatisfied: false,
        candidateDigest: 'sha256:abc',
      }),
    ).toEqual({
      ok: false,
      unmet: [
        { code: 'REQUIRED_CHECK_MISSING', requirement_id: 'tests' },
        { code: 'HUMAN_REVIEW_REQUIRED' },
      ],
    });
  });

  test('rejects evidence with a verification kind that does not match the requirement', () => {
    expect(
      evaluateTaskCompletion({
        contractRevision: 2,
        requirements: [{ ...requirement, kind: 'deployment' }],
        evidence: [evidence],
        openBlockerCount: 0,
        reviewPolicy: { mode: 'human' },
        humanReviewSatisfied: true,
        candidateDigest: 'sha256:abc',
      }),
    ).toEqual({
      ok: false,
      unmet: [{ code: 'REQUIRED_CHECK_MISSING', requirement_id: 'tests' }],
    });
  });

  test('permits optional requirements without evidence after human approval', () => {
    expect(
      evaluateTaskCompletion({
        contractRevision: 1,
        requirements: [{ ...requirement, required: false }],
        evidence: [],
        openBlockerCount: 0,
        reviewPolicy: { mode: 'auto' },
        humanReviewSatisfied: true,
        candidateDigest: 'sha256:abc',
      }),
    ).toEqual({ ok: true });
  });
});
