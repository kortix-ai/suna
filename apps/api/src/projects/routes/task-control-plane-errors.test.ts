import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { TaskTransitionConflictError } from '../generated-state-store';
import {
  completionError,
  isHumanTaskControlPrincipal,
  sessionMatchesTaskLineage,
} from './task-control-plane';

describe('task control-plane HTTP conflicts', () => {
  test('maps a lost task claim to HTTP 409 instead of leaking a 500', () => {
    const error = new TaskTransitionConflictError({
      projectId: 'project-1',
      taskId: 'task-1',
      claimSessionId: null,
      claimExpiresAt: null,
    });

    expect(completionError(error)).toEqual({
      status: 409,
      body: {
        error: error.message,
        code: 'task_transition_conflict',
      },
    });
  });

  test('accepts only an unbound Supabase or PAT human principal', () => {
    expect(isHumanTaskControlPrincipal({ sessionId: null, authType: 'supabase' })).toBe(true);
    expect(isHumanTaskControlPrincipal({ sessionId: null, authType: 'pat' })).toBe(true);
    expect(isHumanTaskControlPrincipal({ sessionId: null, authType: 'apiKey' })).toBe(false);
    expect(
      isHumanTaskControlPrincipal({
        sessionId: null,
        authType: 'service_account',
      }),
    ).toBe(false);
    expect(isHumanTaskControlPrincipal({ sessionId: null, authType: undefined })).toBe(false);
    for (const authType of ['supabase', 'pat', 'apiKey', 'service_account'] as const) {
      expect(
        isHumanTaskControlPrincipal({
          sessionId: 'coordinator-session',
          authType,
        }),
      ).toBe(false);
    }
  });

  test('requires an exact current task lineage match', () => {
    expect(sessionMatchesTaskLineage({ taskId: 'task-1' }, 'task-1')).toBe(true);
    expect(sessionMatchesTaskLineage({ taskId: 'task-2' }, 'task-1')).toBe(false);
    expect(sessionMatchesTaskLineage(null, 'task-1')).toBe(false);
  });

  test('applies the human and lineage guards to every protected mutation route', () => {
    const source = readFileSync(new URL('./task-control-plane.ts', import.meta.url), 'utf8');
    expect(source.match(/isHumanTaskControlPrincipal\(/g)).toHaveLength(6);
    expect(source.match(/sessionMatchesTaskLineage\(/g)).toHaveLength(3);
  });
});
