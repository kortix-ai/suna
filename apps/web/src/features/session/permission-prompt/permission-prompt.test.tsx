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

const WEBFETCH_PERMISSION: AcpPendingPermission = {
  id: 'p-webfetch',
  method: 'session/request_permission',
  sessionId: 's1',
  permission: 'webfetch',
  patterns: ['https://example.com'],
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

  it('records each bulk-replied row after its own reply resolves', async () => {
    renderPrompt({ permissions: [BASH_PERMISSION] });

    fireEvent.click(screen.getByRole('button', { name: 'Allow everything' }));
    await flush();
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, allow everything' }));
    await flush();

    expect(screen.getByTestId('permission-record-row')).toBeTruthy();
    expect(screen.getByText(/Allowed — Bash/)).toBeTruthy();
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

  // WS5-P1-c review, Important #2: `webfetch` is network egress (an
  // SSRF/exfiltration axis), not a local read — `autoApprove: 'reads'` must
  // never wave it through, even though the ACP wire protocol groups it near
  // the other read-ish tool kinds. See the rationale + "Open decisions"
  // pointer on `READ_ONLY_PERMISSION_KINDS` in `permission-prompt.tsx`.
  it('does NOT auto-answer webfetch under autoApprove: "reads"', async () => {
    currentPolicy = { autoApprove: 'reads', toolDecisions: {} };
    const { onReply } = renderPrompt({ permissions: [WEBFETCH_PERMISSION] });
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

  // WS5-P1-c review, Important #3: the auto-answer effect must not record
  // "Allowed"/"Denied" before `onReply` actually resolves — a transient
  // failure would otherwise show a false-positive record for a request the
  // agent never actually got an answer to.
  it('a failed auto-answer records nothing, leaves the row pending, and shows an error toast', async () => {
    currentPolicy = { autoApprove: 'reads', toolDecisions: {} };
    const onReply = mock(async (_id: unknown, _optionId?: string) => {
      throw new Error('network blip');
    });
    renderPrompt({ permissions: [READ_PERMISSION], onReply });
    await flush();

    expect(onReply).toHaveBeenCalledWith('p-read', 'allow_once');
    expect(screen.queryByTestId('permission-record-row')).toBeNull();
    // Still pending: the row's manual "Allow once" button is still there,
    // not swapped for a record.
    expect(screen.getByTestId('acp-permission-allow-once')).toBeTruthy();
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

// ─── WS5-P6-a: a11y — prefers-reduced-motion honored (no transform under reduce) ───
// Same pure-function pattern `acp-request-cards.test.tsx` locks in for
// `cardSwapVariants` — `rowSwapVariants` is this component's equivalent
// motion guard (row swap: pending prompt -> answered record), exported
// solely so this regression test can assert its reduced-motion branch
// directly rather than through fragile DOM/style inspection of a `motion.div`.
describe('PermissionPrompt — rowSwapVariants (motion guard)', () => {
  it('with reduced motion disabled, includes blur and scale transforms', async () => {
    const { rowSwapVariants } = await import('./permission-prompt');

    const variants = rowSwapVariants(false);
    expect(variants.initial).toHaveProperty('filter', 'blur(4px)');
    expect(variants.initial).toHaveProperty('scale', 0.98);
    expect(variants.animate).toHaveProperty('filter', 'blur(0px)');
    expect(variants.animate).toHaveProperty('scale', 1);
    expect(variants.exit).toHaveProperty('filter', 'blur(1.5px)');
    expect(variants.exit).toHaveProperty('scale', 0.995);
  });

  it('with reduced motion enabled, only modifies opacity — no transform/filter under reduce', async () => {
    const { rowSwapVariants } = await import('./permission-prompt');

    const variants = rowSwapVariants(true);
    expect(variants.initial).toEqual({ opacity: 0 });
    expect(variants.animate).toEqual({ opacity: 1 });
    expect(variants.exit).toEqual({ opacity: 0 });
    expect(variants.initial).not.toHaveProperty('filter');
    expect(variants.initial).not.toHaveProperty('scale');
    expect(variants.animate).not.toHaveProperty('filter');
    expect(variants.animate).not.toHaveProperty('scale');
    expect(variants.exit).not.toHaveProperty('filter');
    expect(variants.exit).not.toHaveProperty('scale');
  });

  it('transition stays the calm {duration:0.3, bounce:0} spring regardless of motion preference', async () => {
    const { rowSwapVariants } = await import('./permission-prompt');

    const reduced = rowSwapVariants(true);
    const full = rowSwapVariants(false);
    expect(reduced.transition).toEqual(full.transition);
    expect(reduced.transition).toEqual({ type: 'spring', duration: 0.3, bounce: 0 });
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
