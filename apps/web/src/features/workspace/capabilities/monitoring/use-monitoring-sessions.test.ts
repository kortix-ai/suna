import type { ProjectSession } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import { projectSessionsRefetchInterval } from '@/features/workspace/project-sidebar/project-session-list-helpers';

import { LIVE_BOARD_POLL_MS, boardRefetchInterval } from './use-monitoring-sessions';

const session = (status: string) =>
  ({
    session_id: `s-${status}`,
    status,
    name: 'named',
    custom_name: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    metadata: { name: 'named' },
  }) as unknown as ProjectSession;

describe('boardRefetchInterval', () => {
  test('a running session tightens the sidebar cadence to the live board interval', () => {
    const interval = boardRefetchInterval([session('running'), session('stopped')]);
    expect(interval).toBe(LIVE_BOARD_POLL_MS);
  });

  test('a provisioning session keeps the sidebar faster provisioning poll', () => {
    const interval = boardRefetchInterval([session('provisioning')]);
    expect(typeof interval).toBe('number');
    expect(interval as number).toBeLessThanOrEqual(LIVE_BOARD_POLL_MS);
  });

  test('a settled project falls back to the sidebar rule', () => {
    const settled = [session('stopped'), session('completed'), session('failed')];
    expect(boardRefetchInterval(settled)).toBe(
      projectSessionsRefetchInterval({ sessions: settled, hasOpenSession: true }),
    );
    expect(boardRefetchInterval(settled)).not.toBe(LIVE_BOARD_POLL_MS);
    expect(boardRefetchInterval(undefined)).toBe(
      projectSessionsRefetchInterval({ sessions: undefined, hasOpenSession: true }),
    );
  });
});
