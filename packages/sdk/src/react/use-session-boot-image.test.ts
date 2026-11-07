import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { __getConfigResolver, __setConfigResolver } from '../core/http/config';
import { sessionStartKey, type SessionStartImageStep, type SessionStartResult } from '../core/rest/projects-client';
import { setCurrentRuntime } from '../core/session/current-runtime';
import { useSession } from './runtime-hooks';

/**
 * While `/start` provisions a box, the server names the sandbox image step in
 * `boot.image` (an image still building, the last ready image served instead,
 * a copy to the region). `useSession` hands it to the host as `bootImage`, so a
 * boot screen can say "building the image" instead of a generic spinner. It is
 * null in every other phase, against an API that omits it, and once ready.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT_ID = 'proj_image';
const SESSION_ID = 'kses_image';

const BUILDING: SessionStartImageStep = {
  state: 'building',
  image: 'kortix-session-v42',
  since: '2026-11-02T10:00:00.000Z',
};
const SERVING_LAST_READY: SessionStartImageStep = {
  state: 'serving_last_ready',
  image: 'kortix-session-v41',
  since: '2026-11-02T10:00:05.000Z',
};

function provisioning(image: SessionStartImageStep | null | undefined): SessionStartResult {
  return {
    stage: 'provisioning',
    agent_name: 'default',
    retriable: true,
    sandbox: null,
    runtime_session_id: null,
    boot: {
      phase: 'provisioning',
      since: '2026-11-02T09:59:58.000Z',
      actively_starting: true,
      ...(image === undefined ? {} : { image }),
    },
  };
}

function ready(): SessionStartResult {
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
      external_id: 'sbx_image',
      base_url: null,
      status: 'active',
      config: {},
      metadata: {},
      last_used_at: null,
      created_at: '2026-11-02T00:00:00Z',
      updated_at: '2026-11-02T00:00:00Z',
    } as unknown as NonNullable<SessionStartResult['sandbox']>,
    runtime_session_id: 'ses_image',
    runtime_url: '/p/sbx_image/8000',
    boot: { phase: 'ready', since: '2026-11-02T10:01:00.000Z', actively_starting: false, image: null },
  };
}

let startAnswer: SessionStartResult;
let renderer: ReactTestRenderer | null = null;
let queryClient: QueryClient;
let seen: Array<SessionStartImageStep | null>;

function Host() {
  seen.push(useSession(PROJECT_ID, SESSION_ID, { chatEngine: false, replayStartStash: false }).bootImage);
  return null;
}

/** Answer the next `/start` with `answer` and wait for the hook to render it. */
async function answerStart(answer: SessionStartResult) {
  startAnswer = answer;
  await act(async () => {
    await queryClient.refetchQueries({ queryKey: sessionStartKey(PROJECT_ID, SESSION_ID) });
    // React Query notifies its observers on the next tick.
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

// Scoped, and restored after each test: bun may run several test files in one
// process, and the global `configureKortix` would leak into them.
const realFetch = globalThis.fetch;
let previousResolver: ReturnType<typeof __getConfigResolver> = null;

beforeEach(() => {
  seen = [];
  setCurrentRuntime(null);
  previousResolver = __getConfigResolver();
  __setConfigResolver(() => ({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok' }));
  globalThis.fetch = mock(async (url: unknown) =>
    String(url).includes(`/sessions/${SESSION_ID}/start`)
      ? Response.json(startAnswer)
      : Response.json({ error: 'not_found' }, { status: 404 }),
  ) as unknown as typeof fetch;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  queryClient.clear();
  setCurrentRuntime(null);
  __setConfigResolver(previousResolver);
  globalThis.fetch = realFetch;
});

async function mount(first: SessionStartResult) {
  startAnswer = first;
  await act(async () => {
    renderer = create(createElement(QueryClientProvider, { client: queryClient }, createElement(Host)));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe('useSession bootImage', () => {
  test('follows the provisioning image step, then clears once the session is ready', async () => {
    await mount(provisioning(BUILDING));
    expect(seen.at(-1)).toEqual(BUILDING);

    await answerStart(provisioning(SERVING_LAST_READY));
    expect(seen.at(-1)).toEqual(SERVING_LAST_READY);

    await answerStart(ready());
    expect(seen.at(-1)).toBeNull();
  });

  test('is null against an API that omits the image step', async () => {
    await mount(provisioning(undefined));
    expect(seen.at(-1)).toBeNull();
  });

  test('is null outside the provisioning phase, whatever the payload carries', async () => {
    const booting = provisioning(BUILDING);
    await mount({ ...booting, stage: 'starting', boot: { ...booting.boot!, phase: 'booting' } });
    expect(seen.at(-1)).toBeNull();
  });
});
