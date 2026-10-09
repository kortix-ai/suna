import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { sessionStartKey, type SessionStartResult } from '../core/rest/projects-client';
import { getCurrentRuntimeSandboxId, setCurrentRuntime } from '../core/session/current-runtime';
import { useSession } from './opencode';

/**
 * An ephemeral session keeps its `sandbox_id` (the session id) while its box
 * changes: Stop deletes the box, the next message boots a new one. The view must
 * follow the new box as soon as `/start` names it. It used to key the switch on
 * `sandbox_id`, so it stayed bound to the deleted box ("Lost contact") until a
 * reload.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT_ID = 'proj_box';
const SESSION_ID = 'kses_box';

function readyOn(externalId: string): SessionStartResult {
  return {
    stage: 'ready',
    agent_name: 'default',
    retriable: false,
    sandbox: {
      sandbox_id: SESSION_ID,
      session_id: SESSION_ID,
      project_id: PROJECT_ID,
      account_id: 'acct',
      provider: 'platinum',
      external_id: externalId,
      base_url: null,
      status: 'active',
      config: {},
      metadata: {},
      last_used_at: null,
      created_at: '2026-10-09T00:00:00Z',
      updated_at: '2026-10-09T00:00:00Z',
    } as unknown as NonNullable<SessionStartResult['sandbox']>,
    opencode_session_id: 'ses_box',
    runtime_url: `/p/${externalId}/8000`,
    reason: 'unchanged',
  };
}

let renderer: ReactTestRenderer | null = null;
let queryClient: QueryClient;

function mount(node: ReactNode) {
  act(() => {
    renderer = create(createElement(QueryClientProvider, { client: queryClient }, node));
  });
}

beforeEach(() => {
  setCurrentRuntime(null);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  queryClient.clear();
});

describe('useSession follows the session to a new box', () => {
  test('a ready answer naming a new box re-points the runtime without a reload', async () => {
    // A fresh ready answer is served from cache for 30 s, so no /start fetch runs.
    queryClient.setQueryData(sessionStartKey(PROJECT_ID, SESSION_ID), readyOn('sbx_old'));
    function Host() {
      useSession(PROJECT_ID, SESSION_ID, { chatEngine: false, replayStartStash: false });
      return null;
    }
    mount(createElement(Host));
    expect(getCurrentRuntimeSandboxId()).toBe('sbx_old');

    // Stop deleted the old box; the wake booted a new one under the same sandbox id.
    await act(async () => {
      queryClient.setQueryData(sessionStartKey(PROJECT_ID, SESSION_ID), readyOn('sbx_new'));
      // React Query notifies its observers on the next tick.
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(getCurrentRuntimeSandboxId()).toBe('sbx_new');
  });
});
