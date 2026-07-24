import type { ProjectSession } from '@kortix/sdk/projects-client';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runningSessionWarmupTargets } from './session-cache-warmer-targets';

const keeperSource = readFileSync(
  fileURLToPath(new URL('./session-cache-warmer.tsx', import.meta.url)),
  'utf8',
);

function session(
  sessionId: string,
  status: ProjectSession['status'],
  options: Partial<ProjectSession> = {},
): ProjectSession {
  return {
    session_id: sessionId,
    project_id: 'project-1',
    account_id: 'account-1',
    branch_name: sessionId,
    base_ref: 'main',
    sandbox_provider: 'daytona',
    sandbox_id: sessionId,
    sandbox_url: `https://api.test/v1/p/external-${sessionId}/8000`,
    opencode_session_id: `oc-${sessionId}`,
    name: null,
    custom_name: null,
    agent_name: null,
    status,
    error: null,
    metadata: {},
    opencode_sessions: [],
    created_at: '2026-07-23T00:00:00.000Z',
    updated_at: '2026-07-23T00:00:00.000Z',
    ...options,
  };
}

describe('runningSessionWarmupTargets', () => {
  test('prefetches bounded tails without opening one permanent stream per session', () => {
    expect(keeperSource).toContain('void prefetchSession(');
    expect(keeperSource).not.toContain('openEventStream');
    expect(keeperSource).not.toContain('BackgroundSessionStream');
  });

  test('warms every accessible running session except the active session', () => {
    expect(
      runningSessionWarmupTargets(
        [
          session('active', 'running'),
          session('running-1', 'running'),
          session('running-2', 'running'),
          session('stopped', 'stopped'),
          session('private', 'running', { can_access: false }),
        ],
        'active',
      ),
    ).toEqual([
      {
        openCodeSessionId: 'oc-running-1',
        runtimeUrl: 'https://api.test/v1/p/external-running-1/8000',
      },
      {
        openCodeSessionId: 'oc-running-2',
        runtimeUrl: 'https://api.test/v1/p/external-running-2/8000',
      },
    ]);
  });

  test('skips rows without a canonical OpenCode session or routable sandbox', () => {
    expect(
      runningSessionWarmupTargets(
        [
          session('no-pin', 'running', { opencode_session_id: null }),
          session('no-url', 'running', { sandbox_url: null }),
        ],
        null,
      ),
    ).toEqual([]);
  });
});
