import { describe, expect, test } from 'bun:test';
import type { ProjectTask, TaskBlocker, TaskEvidenceRecord } from '@kortix/sdk';

import {
  artifactFirstEvidence,
  candidateDigestForReview,
  evidenceForRequirement,
  isExternalRef,
  isMissingAccessBlocker,
  latestCandidateDigest,
  orderSessionLineage,
  selectedTaskForFilter,
  taskCandidateIsVerified,
  taskEventDetail,
  taskMatchesFilter,
} from './task-center-helpers';

const task = (status: ProjectTask['status']) => ({ status }) as ProjectTask;
const evidence = (kind: string, createdAt: string, overrides: Partial<TaskEvidenceRecord> = {}) =>
  ({
    evidence_id: `${kind}-${createdAt}`,
    project_id: 'project-1',
    task_id: 'task-1',
    session_id: null,
    contract_revision: 2,
    requirement_id: null,
    kind,
    ref: kind,
    summary: '',
    candidate_digest: 'candidate-1',
    state: 'passed',
    created_at: createdAt,
    ...overrides,
  }) satisfies TaskEvidenceRecord;

describe('task center helpers', () => {
  test('open excludes terminal states and review remains a distinct inbox', () => {
    expect(taskMatchesFilter(task('cancelled'), 'all')).toBe(true);
    expect(taskMatchesFilter(task('doing'), 'open')).toBe(true);
    expect(taskMatchesFilter(task('review'), 'open')).toBe(true);
    expect(taskMatchesFilter(task('done'), 'open')).toBe(false);
    expect(taskMatchesFilter(task('cancelled'), 'open')).toBe(false);
    expect(taskMatchesFilter(task('review'), 'review')).toBe(true);
  });

  test('keeps the selected task inside the active filter', () => {
    const doing = { task_id: 'doing', status: 'doing' } as ProjectTask;
    const done = { task_id: 'done', status: 'done' } as ProjectTask;
    expect(selectedTaskForFilter([doing, done], 'done', 'doing')).toBe(done);
    expect(selectedTaskForFilter([doing], 'done', 'doing')).toBeNull();
  });

  test('orders visual artifacts before implementation evidence', () => {
    const rows = artifactFirstEvidence([
      evidence('command', '2026-08-09T12:00:00.000Z'),
      evidence('artifact', '2026-08-09T10:00:00.000Z'),
      evidence('deployment', '2026-08-09T11:00:00.000Z'),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(['artifact', 'deployment', 'command']);
  });

  test('matches evidence to the current contract revision', () => {
    const rows = [
      evidence('command', '2026-08-09T12:00:00.000Z', {
        requirement_id: 'tests',
        contract_revision: 1,
      }),
      evidence('command', '2026-08-09T13:00:00.000Z', {
        requirement_id: 'tests',
        contract_revision: 2,
      }),
    ];
    expect(
      evidenceForRequirement(
        rows,
        { id: 'tests', kind: 'command', description: 'Tests pass', required: true },
        2,
      )?.contract_revision,
    ).toBe(2);
    expect(latestCandidateDigest(rows)).toBe('candidate-1');
  });

  test('keeps verification evidence scoped to one submitted candidate', () => {
    const rows = [
      evidence('command', '2026-08-09T12:00:00.000Z', {
        requirement_id: 'tests',
        candidate_digest: 'candidate-a',
      }),
      evidence('deployment', '2026-08-09T13:00:00.000Z', {
        requirement_id: 'prod',
        candidate_digest: 'candidate-b',
      }),
    ];
    expect(
      evidenceForRequirement(
        rows,
        { id: 'tests', kind: 'command', description: 'Tests pass', required: true },
        2,
        'candidate-b',
      ),
    ).toBeUndefined();
    expect(
      evidenceForRequirement(
        rows,
        { id: 'tests', kind: 'command', description: 'Tests pass', required: true },
        2,
        null,
      ),
    ).toBeUndefined();
    expect(
      candidateDigestForReview(
        {
          contract_revision: 2,
          verification_requirements: [
            { id: 'tests', kind: 'command', description: 'Tests', required: true },
            { id: 'prod', kind: 'deployment', description: 'Production', required: true },
          ],
        },
        rows,
        [
          {
            event_id: 'event-1',
            event_type: 'task.review_requested',
            actor_type: 'session',
            actor_id: 'coordinator',
            session_id: 'coordinator',
            payload: { candidate_digest: 'candidate-b' },
            created_at: '2026-08-09T14:00:00.000Z',
          },
        ],
      ),
    ).toBe('candidate-b');
    expect(
      candidateDigestForReview(
        {
          contract_revision: 2,
          verification_requirements: [],
          result: { completion: { candidate_digest: 'candidate-completed' } },
        },
        rows,
        [],
      ),
    ).toBe('candidate-completed');
    const contract = {
      contract_revision: 2,
      verification_requirements: [
        { id: 'tests', kind: 'command' as const, description: 'Tests', required: true },
        { id: 'prod', kind: 'deployment' as const, description: 'Production', required: true },
      ],
    };
    expect(taskCandidateIsVerified(contract, rows, 'candidate-a')).toBe(false);
    expect(
      taskCandidateIsVerified(
        { contract_revision: 2, verification_requirements: [] },
        rows,
        'candidate-a',
      ),
    ).toBe(false);
    expect(
      taskCandidateIsVerified(
        contract,
        [
          ...rows,
          evidence('deployment', '2026-08-09T14:00:00.000Z', {
            requirement_id: 'prod',
            candidate_digest: 'candidate-a',
          }),
        ],
        'candidate-a',
      ),
    ).toBe(true);
  });

  test('orders session lineage by parent instead of rendering a flat list', () => {
    const sessions = [
      {
        task_id: 'task-1',
        session_id: 'coordinator',
        role: 'coordinator',
        parent_session_id: null,
        created_at: '2026-08-09T10:00:00.000Z',
      },
      {
        task_id: 'task-1',
        session_id: 'verifier',
        role: 'verifier',
        parent_session_id: 'worker',
        created_at: '2026-08-09T12:00:00.000Z',
      },
      {
        task_id: 'task-1',
        session_id: 'worker',
        role: 'worker',
        parent_session_id: 'coordinator',
        created_at: '2026-08-09T11:00:00.000Z',
      },
    ] as const;
    expect(
      orderSessionLineage(sessions).map(({ session, depth }) => [session.session_id, depth]),
    ).toEqual([
      ['coordinator', 0],
      ['worker', 1],
      ['verifier', 2],
    ]);
  });

  test('turns event payloads into reviewable timeline details', () => {
    expect(
      taskEventDetail({
        event_id: 'event-1',
        event_type: 'task.status_changed',
        actor_type: 'platform',
        actor_id: null,
        session_id: null,
        payload: { from: 'doing', to: 'review' },
        created_at: '2026-08-09T12:00:00.000Z',
      }),
    ).toBe('doing → review');
  });

  test('recognizes access blockers and only safe external evidence links', () => {
    expect(
      isMissingAccessBlocker({
        category: 'permission',
        requested_action: 'Grant Drive access',
      } as TaskBlocker),
    ).toBe(true);
    expect(isExternalRef('https://example.com/demo')).toBe(true);
    expect(isExternalRef('javascript:alert(1)')).toBe(false);
    expect(isExternalRef('/workspace/demo.png')).toBe(false);
  });
});
