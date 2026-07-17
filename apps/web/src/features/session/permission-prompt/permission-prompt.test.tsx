import type { AcpPendingPermission } from '@kortix/sdk';
import type { AcpPermissionPolicy } from '@kortix/sdk/projects-client';

// Same `@happy-dom/global-registrator` + dynamic-import dance
// `model-picker.test.tsx` established (this package's other component test
// needing a real DOM): a plain `import { GlobalRegistrator } from
// '@happy-dom/global-registrator'; GlobalRegistrator.register()` followed by
// a static `import { screen } from '@testing-library/react'` still evaluates
// testing-library BEFORE registration runs (ESM hoists static imports), so
// `screen` gets stuck on its permanently-throwing "no document" stub. Only
// dynamic `import()` under top-level `await` forces registration first.
const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
delete (globalThis as any).window;
delete (globalThis as any).document;
GlobalRegistrator.register();

const { afterAll, afterEach, describe, expect, it, mock } = await import('bun:test');
const { act, cleanup, fireEvent, render, screen, within } = await import('@testing-library/react');

// `usePermissionPolicy` (Task WS5-P1-a/b) and `useSessionAudit`/
// `useResolveApproval` (the connector-approval lock) all call
// `useQuery`/`useMutation`/`useQueryClient` — none of which have a
// `QueryClientProvider` to talk to in this harness. Mocked at the module
// boundary, `usePermissionPolicy` **spreading the real module** (per the
// mandated test list) so every other `@kortix/sdk/react` export a future
// import here might need stays real.
let currentPolicy: AcpPermissionPolicy = { autoApprove: 'none', toolDecisions: {} };
const rememberToolDecisionMock = mock(async (_tool: string, _decision: 'allow' | 'deny') => {});
const actualSdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...actualSdkReact,
  usePermissionPolicy: () => ({
    policy: currentPolicy,
    isLoading: false,
    setAutoApprove: async () => {},
    rememberToolDecision: rememberToolDecisionMock,
  }),
}));

let connectorActions: unknown[] = [];
const resolveConnectorMutateMock = mock((_vars: unknown, _opts?: { onSuccess?: () => void }) => {});
mock.module('../session-audit-shared', () => ({
  isPendingAction: (a: { status: string; resolved_at: string | null }) =>
    a.status === 'pending_approval' && !a.resolved_at,
  relativeTime: () => 'just now',
  riskTone: () => 'muted',
  useSessionAudit: () => ({ data: { actions: connectorActions } }),
  useResolveApproval: () => ({
    mutate: resolveConnectorMutateMock,
    mutateAsync: async () => {},
    isPending: false,
  }),
}));

mock.module('@/lib/use-project-can', () => ({
  useProjectCan: () => ({ allowed: false, reason: null, isLoading: false, isError: false }),
}));

const { PermissionPrompt } = await import('./permission-prompt');

afterEach(() => {
  cleanup();
  connectorActions = [];
  currentPolicy = { autoApprove: 'none', toolDecisions: {} };
  rememberToolDecisionMock.mockClear();
  resolveConnectorMutateMock.mockClear();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

const BASH_PERMISSION: AcpPendingPermission = {
  id: 'p-bash',
  method: 'session/request_permission',
  sessionId: 's1',
  permission: 'Bash',
  patterns: ['rm -rf /tmp/x'],
  options: [
    { optionId: 'allow_once', kind: 'allow_once', label: 'Allow once', value: 'allow_once' },
    { optionId: 'allow_always', kind: 'allow_always', label: 'Allow for session', value: 'allow_always' },
    { optionId: 'reject_once', kind: 'reject_once', label: 'Reject', value: 'reject_once' },
  ],
  params: {},
};

const READ_PERMISSION: AcpPendingPermission = {
  id: 'p-read',
  method: 'session/request_permission',
  sessionId: 's1',
  permission: 'read',
  patterns: ['src/index.ts'],
  options: [
    { optionId: 'allow_once', kind: 'allow_once', label: 'Allow once', value: 'allow_once' },
    { optionId: 'reject_once', kind: 'reject_once', label: 'Reject', value: 'reject_once' },
  ],
  params: {},
};

function renderPrompt(over: {
  permissions?: AcpPendingPermission[];
  autoApprove?: boolean;
  onAutoApproveChange?: (v: boolean) => void;
  onReply?: (id: unknown, optionId?: string) => Promise<void> | void;
} = {}) {
  const onReply = over.onReply ?? mock(async (_id: unknown, _optionId?: string) => {});
  const onAutoApproveChange = over.onAutoApproveChange ?? mock((_v: boolean) => {});
  render(
    <PermissionPrompt
      projectId="proj_1"
      sessionId="sess_1"
      permissions={over.permissions ?? []}
      autoApprove={over.autoApprove ?? false}
      onAutoApproveChange={onAutoApproveChange}
      onReply={onReply as never}
    />,
  );
  return { onReply, onAutoApproveChange };
}

describe('PermissionPrompt — zero amber', () => {
  it('never renders an amber-* class anywhere in its DOM', () => {
    const { container } = render(
      <PermissionPrompt
        projectId="proj_1"
        sessionId="sess_1"
        permissions={[BASH_PERMISSION]}
        autoApprove={false}
        onAutoApproveChange={() => {}}
        onReply={async () => {}}
      />,
    );
    expect(container.innerHTML).not.toContain('amber');
  });
});

describe('PermissionPrompt — action order', () => {
  it('renders Deny, then Allow once, then Allow for session, left to right', () => {
    renderPrompt({ permissions: [BASH_PERMISSION] });
    const labels = screen
      .getAllByRole('button')
      .map((btn) => btn.textContent?.trim())
      .filter((text): text is string => !!text && ['Deny', 'Allow once', 'Allow for session'].includes(text));
    expect(labels).toEqual(['Deny', 'Allow once', 'Allow for session']);
  });
});

describe('PermissionPrompt — allow everything is behind ConfirmDialog', () => {
  it('does not call onReply until the confirmation is accepted', async () => {
    const { onReply } = renderPrompt({ permissions: [BASH_PERMISSION] });

    fireEvent.click(screen.getByRole('button', { name: 'Allow everything' }));
    await flush();

    expect(onReply).not.toHaveBeenCalled();
    expect(screen.getByText('Allow everything for this session?')).toBeTruthy();

    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, allow everything' }));
    await flush();

    expect(onReply).toHaveBeenCalledWith('p-bash', 'allow_once');
  });
});

describe('PermissionPrompt — persistent policy auto-answer', () => {
  it('autoApprove: "reads" auto-answers a read-kind permission with no click', async () => {
    currentPolicy = { autoApprove: 'reads', toolDecisions: {} };
    const { onReply } = renderPrompt({ permissions: [READ_PERMISSION] });
    await flush();

    expect(onReply).toHaveBeenCalledWith('p-read', 'allow_once');
  });

  it('does NOT auto-answer a non-read kind under autoApprove: "reads"', async () => {
    currentPolicy = { autoApprove: 'reads', toolDecisions: {} };
    const { onReply } = renderPrompt({ permissions: [BASH_PERMISSION] });
    await flush();

    expect(onReply).not.toHaveBeenCalled();
  });

  it('a remembered toolDecisions[tool] === "allow" auto-answers regardless of kind', async () => {
    currentPolicy = { autoApprove: 'none', toolDecisions: { Bash: 'allow' } };
    const { onReply } = renderPrompt({ permissions: [BASH_PERMISSION] });
    await flush();

    expect(onReply).toHaveBeenCalledWith('p-bash', 'allow_once');
  });

  it('a remembered toolDecisions[tool] === "deny" auto-denies through the same respond path', async () => {
    currentPolicy = { autoApprove: 'none', toolDecisions: { Bash: 'deny' } };
    const { onReply } = renderPrompt({ permissions: [BASH_PERMISSION] });
    await flush();

    expect(onReply).toHaveBeenCalledWith('p-bash', 'reject_once');
  });
});

describe('PermissionPrompt — remember for this project', () => {
  it('toggling the switch calls rememberToolDecision(tool, "allow")', () => {
    renderPrompt({ permissions: [BASH_PERMISSION] });

    const toggle = screen.getByRole('switch', { name: 'Remember for this project' });
    fireEvent.click(toggle);

    expect(rememberToolDecisionMock).toHaveBeenCalledWith('Bash', 'allow');
  });
});

describe('PermissionPrompt — answered record row', () => {
  it('Allow once swaps the row for a compact answered record', async () => {
    renderPrompt({ permissions: [BASH_PERMISSION] });

    fireEvent.click(screen.getByTestId('acp-permission-allow-once'));
    await flush();

    expect(screen.getByTestId('permission-record-row')).toBeTruthy();
    expect(screen.getByText(/Allowed — Bash/)).toBeTruthy();
  });
});

describe('PermissionPrompt — auto-approve strip', () => {
  it('shows the muted strip with Turn off when the session autoApprove flag is on', () => {
    const onAutoApproveChange = mock((_v: boolean) => {});
    renderPrompt({ autoApprove: true, onAutoApproveChange });

    expect(screen.getByTestId('acp-session-permission-autoapprove')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    expect(onAutoApproveChange).toHaveBeenCalledWith(false);
  });
});

describe('PermissionPrompt — empty state', () => {
  it('renders nothing when there is no pending permission, no connector action, and autoApprove is off', () => {
    const { container } = render(
      <PermissionPrompt
        projectId="proj_1"
        sessionId="sess_1"
        permissions={[]}
        autoApprove={false}
        onAutoApproveChange={() => {}}
        onReply={async () => {}}
      />,
    );
    expect(container.innerHTML).toBe('');
  });
});
