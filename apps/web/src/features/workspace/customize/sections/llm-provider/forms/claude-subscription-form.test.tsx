import type { ModelsPageRuntime } from '@kortix/sdk/react';

// Same `@happy-dom/global-registrator` + dynamic-import dance
// `connect-modal-host.test.tsx` / `runtime-view.test.tsx` establish — a plain
// static `import { screen } from '@testing-library/react'` evaluates before
// `GlobalRegistrator` registers (ESM hoists static imports), leaving `screen`
// stuck on its permanently-throwing "no document" stub. Only dynamic
// `import()` under top-level `await` forces registration first.
const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
delete (globalThis as any).window;
delete (globalThis as any).document;
GlobalRegistrator.register();

const { afterAll, afterEach, describe, expect, mock, test } = await import('bun:test');
const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react');
const ReactModule = await import('react');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');

// Unlike the mocked-`useMutation` convention some sibling suites use, this
// file spins up a REAL `QueryClient` and lets the component's own
// `useMutation` run for real. That is the whole point of the contract-pin
// test below: it has to prove the actual mutation the component builds
// still calls `upsertProjectSecret`/`setActiveHarnessConnection` with the
// same payload it did before the stepper refactor, not just that some mock
// was invoked.
let upsertProjectSecretCalls: Array<{ projectId: string; input: { name: string; value?: string } }> =
  [];
let setActiveHarnessConnectionCalls: Array<{ projectId: string; harness: string; kind: string }> = [];

const actualProjectsClient = await import('@kortix/sdk/projects-client');
mock.module('@kortix/sdk/projects-client', () => ({
  ...actualProjectsClient,
  upsertProjectSecret: async (projectId: string, input: { name: string; value?: string }) => {
    upsertProjectSecretCalls.push({ projectId, input });
    return { id: 'secret_1' };
  },
  setActiveHarnessConnection: async (projectId: string, harness: string, kind: string) => {
    setActiveHarnessConnectionCalls.push({ projectId, harness, kind });
  },
}));

// `ProviderLogo` renders `next/image`, whose `getImgProps` constructs a
// `URL` from the icon's relative asset path — happy-dom has no real page
// location to resolve that against and throws "Invalid URL", same stub
// `runtime-view.test.tsx` uses.
mock.module('next/image', () => ({
  default: (props: Record<string, unknown>) => {
    const { src, alt, ...rest } = props;
    return ReactModule.createElement('img', { src, alt, ...rest });
  },
}));

const { ClaudeSubscriptionForm } = await import('./claude-subscription-form');

function withQueryClient(node: React.ReactNode) {
  const queryClient = new QueryClient();
  return ReactModule.createElement(QueryClientProvider, { client: queryClient }, node);
}

const RUNTIMES: ModelsPageRuntime[] = [
  {
    id: 'claude',
    harness: 'claude',
    label: 'Claude Code',
    status: 'missing',
    selectedConnectionId: null,
    modelSummary: null,
    compatibleConnectionIds: ['claude_subscription', 'anthropic_api_key'],
    blocker: null,
  },
];

function renderForm(onConnected: () => void = () => {}) {
  return render(
    withQueryClient(
      ReactModule.createElement(ClaudeSubscriptionForm, {
        projectId: 'proj_1',
        runtimes: RUNTIMES,
        onConnected,
      }),
    ),
  );
}

afterEach(() => {
  cleanup();
  upsertProjectSecretCalls = [];
  setActiveHarnessConnectionCalls = [];
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

const VALID_TOKEN = 'a'.repeat(24);

describe('ClaudeSubscriptionForm — two-step stepper', () => {
  test('step 1 shows the setup-token command and a docs link, no password field yet', () => {
    renderForm();
    expect(screen.getByText('claude setup-token')).toBeDefined();
    expect(screen.getByRole('link', { name: /anthropic auth docs/i })).toBeDefined();
    expect(screen.queryByLabelText('Claude subscription token')).toBeNull();
  });

  test('Continue advances to step 2, where the password field appears', () => {
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByLabelText('Claude subscription token')).toBeDefined();
  });

  test('clicking the step 1 indicator from step 2 returns to step 1', () => {
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByLabelText('Claude subscription token')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /step 1/i }));
    expect(screen.queryByLabelText('Claude subscription token')).toBeNull();
    expect(screen.getByText('claude setup-token')).toBeDefined();
  });

  test('submit stays disabled under 20 characters and the hint says keep pasting', () => {
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    const input = screen.getByLabelText('Claude subscription token');
    fireEvent.change(input, { target: { value: 'short-token' } });

    const submit = screen.getByRole('button', { name: /connect claude/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(screen.getByText(/keep pasting/i)).toBeDefined();
  });

  test('submit enables and the hint confirms once the token reaches 20 characters', () => {
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    const input = screen.getByLabelText('Claude subscription token');
    fireEvent.change(input, { target: { value: VALID_TOKEN } });

    const submit = screen.getByRole('button', { name: /connect claude/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(screen.getByText(/looks like a token/i)).toBeDefined();
  });

  test('CONTRACT PIN — submit still writes CLAUDE_CODE_OAUTH_TOKEN and applies the selected runtime, exactly like before the stepper refactor', async () => {
    const onConnected = mock(() => {});
    renderForm(onConnected);

    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    const input = screen.getByLabelText('Claude subscription token');
    fireEvent.change(input, { target: { value: VALID_TOKEN } });

    // The fixture runtime is `status: 'missing'`, so `defaultUseWithHarnesses`
    // (unchanged by this refactor) pre-checks "Use with Claude Code" — the
    // "first compatible connection" rule from the handoff. Assert against
    // that default selection rather than re-toggling it (a click here would
    // UNCHECK it and legitimately produce zero `setActiveHarnessConnection`
    // calls — that footgun is exactly why this is called out).
    expect(screen.getByRole('checkbox', { name: 'Claude Code' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: /connect claude/i }));

    await waitFor(() => expect(upsertProjectSecretCalls.length).toBe(1));
    expect(upsertProjectSecretCalls[0]).toEqual({
      projectId: 'proj_1',
      input: { name: 'CLAUDE_CODE_OAUTH_TOKEN', value: VALID_TOKEN },
    });

    await waitFor(() => expect(setActiveHarnessConnectionCalls.length).toBe(1));
    expect(setActiveHarnessConnectionCalls[0]).toEqual({
      projectId: 'proj_1',
      harness: 'claude',
      kind: 'claude_subscription',
    });

    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
  });
});
