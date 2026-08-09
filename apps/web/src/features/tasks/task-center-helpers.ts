import type {
  ProjectTask,
  TaskBlocker,
  TaskEvent,
  TaskEvidenceRecord,
  TaskSessionLink,
  TaskVerificationRequirement,
} from '@kortix/sdk';

export type TaskInboxFilter = 'all' | 'open' | 'review' | 'blocked' | 'done';

export function taskMatchesFilter(task: ProjectTask, filter: TaskInboxFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'open') return !['done', 'cancelled'].includes(task.status);
  return task.status === filter;
}

export function taskFilterCount(tasks: readonly ProjectTask[], filter: TaskInboxFilter): number {
  return tasks.filter((task) => taskMatchesFilter(task, filter)).length;
}

export function selectedTaskForFilter(
  tasks: readonly ProjectTask[],
  filter: TaskInboxFilter,
  requestedTaskId: string | null,
): ProjectTask | null {
  const filtered = tasks.filter((task) => taskMatchesFilter(task, filter));
  return filtered.find((task) => task.task_id === requestedTaskId) ?? filtered[0] ?? null;
}

const EVIDENCE_ORDER: Record<string, number> = {
  artifact: 0,
  deployment: 1,
  http: 2,
  command: 3,
  monitor: 4,
  policy: 5,
  human: 6,
};

/** Put the result a reviewer can inspect before implementation-level checks. */
export function artifactFirstEvidence(
  evidence: readonly TaskEvidenceRecord[],
): TaskEvidenceRecord[] {
  return [...evidence].sort((left, right) => {
    const kind = (EVIDENCE_ORDER[left.kind] ?? 99) - (EVIDENCE_ORDER[right.kind] ?? 99);
    if (kind !== 0) return kind;
    return Date.parse(right.created_at) - Date.parse(left.created_at);
  });
}

export function evidenceForRequirement(
  evidence: readonly TaskEvidenceRecord[],
  requirement: TaskVerificationRequirement,
  revision: number,
  candidateDigest?: string | null,
): TaskEvidenceRecord | undefined {
  return evidence.find(
    (item) =>
      item.requirement_id === requirement.id &&
      item.contract_revision === revision &&
      (candidateDigest === undefined ||
        (candidateDigest !== null && item.candidate_digest === candidateDigest)) &&
      item.state === 'passed',
  );
}

/** The review-request event names the exact candidate the worker submitted. */
export function candidateDigestForReview(
  task: Pick<ProjectTask, 'contract_revision' | 'verification_requirements'> & {
    result?: Record<string, unknown>;
  },
  evidence: readonly TaskEvidenceRecord[],
  events: readonly TaskEvent[],
): string | null {
  const completion = task.result?.completion;
  if (completion && typeof completion === 'object') {
    const digest = (completion as Record<string, unknown>).candidate_digest;
    if (typeof digest === 'string' && digest) return digest;
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const digest = event?.payload.candidate_digest;
    if (event?.event_type === 'task.review_requested' && typeof digest === 'string' && digest) {
      return digest;
    }
  }

  const revision = task.contract_revision ?? 1;
  const required = new Set(
    (task.verification_requirements ?? []).filter((item) => item.required).map((item) => item.id),
  );
  const candidates = new Map<string, { requirementIds: Set<string>; lastSeen: number }>();
  for (const item of evidence) {
    if (item.contract_revision !== revision || item.state !== 'passed') continue;
    const current = candidates.get(item.candidate_digest) ?? {
      requirementIds: new Set<string>(),
      lastSeen: 0,
    };
    if (item.requirement_id) current.requirementIds.add(item.requirement_id);
    current.lastSeen = Math.max(current.lastSeen, Date.parse(item.created_at) || 0);
    candidates.set(item.candidate_digest, current);
  }
  return (
    [...candidates.entries()]
      .filter(([, candidate]) => [...required].every((id) => candidate.requirementIds.has(id)))
      .sort((left, right) => right[1].lastSeen - left[1].lastSeen)[0]?.[0] ?? null
  );
}

export function taskCandidateIsVerified(
  task: Pick<ProjectTask, 'contract_revision' | 'verification_requirements'>,
  evidence: readonly TaskEvidenceRecord[],
  candidateDigest: string | null,
): boolean {
  if (!candidateDigest) return false;
  const revision = task.contract_revision ?? 1;
  const required = (task.verification_requirements ?? []).filter(
    (requirement) => requirement.required,
  );
  return (
    required.length > 0 &&
    required.every(
      (requirement) =>
        evidenceForRequirement(evidence, requirement, revision, candidateDigest) !== undefined,
    )
  );
}

export function latestCandidateDigest(evidence: readonly TaskEvidenceRecord[]): string | null {
  const sorted = [...evidence].sort(
    (left, right) => Date.parse(right.created_at) - Date.parse(left.created_at),
  );
  return sorted.find((item) => item.candidate_digest.trim().length > 0)?.candidate_digest ?? null;
}

export function openTaskBlockers(blockers: readonly TaskBlocker[]): TaskBlocker[] {
  return blockers.filter((blocker) => blocker.status === 'open');
}

export interface SessionLineageItem {
  session: TaskSessionLink;
  depth: number;
}

export function taskEventDetail(event: TaskEvent): string | null {
  const payload = event.payload;
  if (event.event_type === 'task.status_changed') {
    const from = typeof payload.from === 'string' ? payload.from : null;
    const to = typeof payload.to === 'string' ? payload.to : null;
    return from && to ? `${from} → ${to}` : null;
  }
  if (event.event_type === 'task.review_requested') {
    return typeof payload.candidate_digest === 'string'
      ? `Candidate ${payload.candidate_digest}`
      : null;
  }
  if (event.event_type === 'task.contract_revised') {
    return typeof payload.to_revision === 'number' ? `Revision ${payload.to_revision}` : null;
  }
  if (event.event_type === 'task.blocker_created') {
    return typeof payload.category === 'string' ? payload.category : null;
  }
  if (event.event_type === 'task.evidence_added') {
    const state = typeof payload.state === 'string' ? payload.state : null;
    const requirement = typeof payload.requirement_id === 'string' ? payload.requirement_id : null;
    return [state, requirement].filter(Boolean).join(' · ') || null;
  }
  if (event.event_type === 'task.canceled') {
    return typeof payload.reason === 'string' ? payload.reason : null;
  }
  return null;
}

/** Preserve creation order while rendering actual parent-child session relationships. */
export function orderSessionLineage(sessions: readonly TaskSessionLink[]): SessionLineageItem[] {
  const byParent = new Map<string | null, TaskSessionLink[]>();
  const ids = new Set(sessions.map((item) => item.session_id));
  for (const session of sessions) {
    const parent =
      session.parent_session_id && ids.has(session.parent_session_id)
        ? session.parent_session_id
        : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), session]);
  }

  const result: SessionLineageItem[] = [];
  const visited = new Set<string>();
  const visit = (session: TaskSessionLink, depth: number) => {
    if (visited.has(session.session_id)) return;
    visited.add(session.session_id);
    result.push({ session, depth });
    for (const child of byParent.get(session.session_id) ?? []) visit(child, depth + 1);
  };
  for (const root of byParent.get(null) ?? []) visit(root, 0);
  for (const session of sessions) visit(session, 0);
  return result;
}

export function isMissingAccessBlocker(blocker: TaskBlocker): boolean {
  return /access|auth|credential|permission|secret/i.test(
    `${blocker.category} ${blocker.requested_action}`,
  );
}

export function isExternalRef(ref: string): boolean {
  try {
    const url = new URL(ref);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
