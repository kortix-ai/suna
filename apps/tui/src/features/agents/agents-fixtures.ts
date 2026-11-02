/**
 * Synthetic rows for the agents tests: a lead session, its children and one
 * workflow run. Only the fields the model reads are real; the rest is cast.
 */

import type { ProjectSession, WorkflowRunMetadata } from '@kortix/sdk';

export const NOW = Date.parse('2026-11-02T12:00:00Z');
export const MIN = 60_000;
export const LEAD = 'lead-0000-0000';

/** A child session row with only the fields the model reads. */
export function child(id: string, overrides: Partial<ProjectSession> = {}): ProjectSession {
  return {
    session_id: id,
    name: null,
    agent_name: 'kortix',
    agent_handle: null,
    status: 'running',
    board_state: 'working',
    attention: null,
    result_excerpt: null,
    last_activity_at: new Date(NOW - MIN).toISOString(),
    created_at: new Date(NOW - 10 * MIN).toISOString(),
    updated_at: new Date(NOW - MIN).toISOString(),
    parent_session_id: LEAD,
    team_lead_session_id: null,
    ...overrides,
  } as ProjectSession;
}

export function run(overrides: Partial<WorkflowRunMetadata> = {}): WorkflowRunMetadata {
  return {
    runId: 'run-1',
    title: 'Audit the repo',
    status: 'running',
    phases: [],
    startedAt: NOW - 5 * MIN,
    agents: [
      { id: 'a1', label: 'scan api', status: 'done', sessionId: 'wf-a1' },
      { id: 'a2', label: 'scan web', status: 'done', sessionId: 'wf-a2' },
      { id: 'a3', label: 'scan cli', status: 'done', sessionId: 'wf-a3' },
      { id: 'a4', label: 'scan sdk', status: 'running', sessionId: 'wf-a4', startedAt: NOW - 2 * MIN },
      { id: 'a5', label: 'scan ui', status: 'failed', sessionId: 'wf-a5' },
      { id: 'a6', label: 'scan db', status: 'starting' },
      { id: 'a7', label: 'scan tui', status: 'stopped', sessionId: 'wf-a7' },
      { id: 'a8', label: 'report', status: 'starting' },
    ],
    ...overrides,
  };
}

