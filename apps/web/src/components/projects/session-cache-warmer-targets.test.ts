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
    runtime_session_id: `runtime-session-${sessionId}`,
    runtime_protocol: 'acp',
    runtime_id: `runtime-${sessionId}`,
    acp_session_id: `acp-${sessionId}`,
    name: null,
    custom_name: null,
    agent_name: null,
    status,
    error: null,
    metadata: {},
    runtime_sessions: [],
    created_at: '2026-07-23T00:00:00.000Z',
    updated_at: '2026-07-23T00:00:00.000Z',
    ...options,
  };
}

describe('runningSessionWarmupTargets', () => {
  test('seeds ACP readiness without opening one permanent stream per session', () => {
    expect(keeperSource).toContain('queryClient.setQueryData');
    expect(keeperSource).not.toContain('prefetchSession');
    expect(keeperSource).not.toContain('openEventStream');
    expect(keeperSource).not.toContain('BackgroundSessionStream');
    expect(keeperSource).not.toContain('OpenCode');
  });

  test('warms every accessible ACP session except the active session', () => {
    const targets = runningSessionWarmupTargets(
      [
        session('active', 'running'),
        session('running-1', 'running'),
        session('running-2', 'running'),
        session('stopped', 'stopped'),
        session('private', 'running', { can_access: false }),
      ],
      'active',
    );
    expect(
      targets.map(({ sessionId, startSeed }) => ({
        sessionId,
        runtimeId: startSeed.runtime_id,
        runtimeUrl: startSeed.runtime_url,
      })),
    ).toEqual([
      {
        sessionId: 'running-1',
        runtimeId: 'runtime-running-1',
        runtimeUrl: 'https://api.test/v1/p/external-running-1/8000',
      },
      {
        sessionId: 'running-2',
        runtimeId: 'runtime-running-2',
        runtimeUrl: 'https://api.test/v1/p/external-running-2/8000',
      },
    ]);
  });

  test('skips rows without an ACP runtime or routable sandbox', () => {
    expect(
      runningSessionWarmupTargets(
        [
          session('no-runtime', 'running', { runtime_id: null }),
          session('wrong-protocol', 'running', { runtime_protocol: null }),
          session('no-url', 'running', { sandbox_url: null }),
        ],
        null,
      ),
    ).toEqual([]);
  });
});
