export type TaskVerificationKind =
  | 'command'
  | 'http'
  | 'artifact'
  | 'deployment'
  | 'policy'
  | 'human'
  | 'monitor';

export interface TaskVerificationRequirement {
  id: string;
  kind: TaskVerificationKind;
  description: string;
  required: boolean;
}

export interface TaskCompletionEvidence {
  evidenceId: string;
  requirementId: string | null;
  kind: string;
  contractRevision: number;
  candidateDigest: string;
  state: 'passed' | 'failed' | 'info';
}

export type TaskCompletionUnmetCondition =
  | { code: 'OPEN_BLOCKERS'; count: number }
  | { code: 'REQUIRED_CHECK_MISSING'; requirement_id: string }
  | { code: 'HUMAN_REVIEW_REQUIRED' };

export type TaskCompletionDecision =
  | { ok: true }
  | { ok: false; unmet: TaskCompletionUnmetCondition[] };

export function evaluateTaskCompletion(input: {
  contractRevision: number;
  requirements: readonly TaskVerificationRequirement[];
  evidence: readonly TaskCompletionEvidence[];
  openBlockerCount: number;
  reviewPolicy: { mode: 'auto' | 'human' };
  humanReviewSatisfied: boolean;
  candidateDigest: string;
}): TaskCompletionDecision {
  const unmet: TaskCompletionUnmetCondition[] = [];
  if (input.openBlockerCount > 0) {
    unmet.push({ code: 'OPEN_BLOCKERS', count: input.openBlockerCount });
  }

  for (const requirement of input.requirements) {
    if (!requirement.required) continue;
    const passed = input.evidence.some(
      (item) =>
        item.requirementId === requirement.id &&
        item.kind === requirement.kind &&
        item.contractRevision === input.contractRevision &&
        item.candidateDigest === input.candidateDigest &&
        item.state === 'passed',
    );
    if (!passed) {
      unmet.push({ code: 'REQUIRED_CHECK_MISSING', requirement_id: requirement.id });
    }
  }

  // V1 has no trusted verifier producer. Evidence recorded by a task-lineage
  // session is useful review material, but it cannot authorize completion.
  // Keep the contract policy in the input for forward-compatible storage while
  // requiring a human principal for every completion decision.
  if (!input.humanReviewSatisfied) {
    unmet.push({ code: 'HUMAN_REVIEW_REQUIRED' });
  }
  return unmet.length === 0 ? { ok: true } : { ok: false, unmet };
}
