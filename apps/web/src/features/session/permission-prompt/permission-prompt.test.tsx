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
const setAutoApproveMock = mock(async (_mode: 'none' | 'reads' | 'all') => {});
const actualSdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...actualSdkReact,
  usePermissionPolicy: () => ({
    policy: currentPolicy,
    isLoading: false,
    setAutoApprove: setAutoApproveMock,
    rememberToolDecision: rememberToolDecisionMock,
  }),
}));

let connectorActions: unknown[] = [];
const resolveConnectorMutateMock = mock(
  (_vars: unknown, opts?: { onSuccess?: () => void; onError?: (e: unknown) => void }) => {
    opts?.onSuccess?.();
  },
);
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

// Project-policy writes are the connector side of "don't ask again in this
// project". Mocked at the client boundary so the checkbox's persistence
// contract can be asserted without a REST layer.
const listProjectPoliciesMock = mock(async (_projectId: string) => ({
  policies: [] as { match: string; action: string }[],
  defaultMode: 'risk' as const,
  errors: [],
}));
const setProjectPoliciesMock = mock(
  async (_projectId: string, _policies: unknown[], _defaultMode: string) => ({ ok: true }),
);
const actualProjectsClient = await import('@kortix/sdk/projects-client');
mock.module('@kortix/sdk/projects-client', () => ({
  ...actualProjectsClient,
  listProjectPolicies: listProjectPoliciesMock,
  setProjectPolicies: setProjectPoliciesMock,
}));

let canWritePolicies = false;
mock.module('@/lib/use-project-can', () => ({
  useProjectCan: () => ({ allowed: canWritePolicies, reason: null, isLoading: false, isError: false }),
}));

const { TooltipProvider } = await import('@/components/ui/tooltip');
const { PermissionPrompt } = await import('./permission-prompt');

afterEach(() => {
  cleanup();
  connectorActions = [];
  canWritePolicies = false;
  currentPolicy = { autoApprove: 'none', toolDecisions: {} };
  rememberToolDecisionMock.mockClear();
  setAutoApproveMock.mockClear();
  resolveConnectorMutateMock.mockClear();
  listProjectPoliciesMock.mockClear();
  setProjectPoliciesMock.mockClear();
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

/** A harness-specific option `resolvePermissionActionOptions` cannot map onto
 *  allow-once / allow-session / deny — the `extra` bucket that now lives
 *  behind the row's overflow menu instead of as a fourth inline button. */
const EXTRA_OPTION_PERMISSION: AcpPendingPermission = {
  id: 'p-edit',
  method: 'session/request_permission',
  sessionId: 's1',
  permission: 'edit',
  patterns: ['src/app.ts'],
  options: [
    { optionId: 'allow_once', kind: 'allow_once', label: 'Allow once', value: 'allow_once' },
    { optionId: 'reject_once', kind: 'reject_once', label: 'Reject', value: 'reject_once' },
    { optionId: 'allow_dir', kind: 'custom', label: 'Allow everything in this folder', value: 'allow_dir' },
  ],
  params: {},
};

/** What OpenCode actually sends: `acp/reduce.ts`'s `projectPermission` ranks
 *  `params.title` above `toolCall.kind`, so `permission.permission` is the
 *  whole shell invocation and `patterns` is empty. Taken verbatim from a real
 *  session. */
const RAW_COMMAND_PERMISSION: AcpPendingPermission = {
  id: 'p-raw',
  method: 'session/request_permission',
  sessionId: 's1',
  permission: 'mkdir -p /workspace/jay-suthar-portfolio/assets',
  patterns: [],
  options: [
    { optionId: 'allow_once', kind: 'allow_once', label: 'Allow once', value: 'allow_once' },
    { optionId: 'reject_once', kind: 'reject_once', label: 'Reject', value: 'reject_once' },
  ],
  params: {},
};

const CONNECTOR_ACTION = {
  execution_id: 'exec-1',
  action: 'linear.create_issue',
  connector: 'linear',
  risk: 'write',
  status: 'pending_approval',
  resolved_at: null,
  at: '2026-07-22T00:00:00.000Z',
};

function renderPrompt(over: {
  permissions?: AcpPendingPermission[];
  autoApprove?: boolean;
  onAutoApproveChange?: (v: boolean) => void;
  onReply?: (id: unknown, optionId?: string) => Promise<void> | void;
  /** The bypass-all mode-flip. Defaults to a mock that reports a permissive
   *  mode was applied — the blanket scopes call this so the harness stops
   *  sending fresh `session/request_permission`s. */
  onAllowAllMode?: () => Promise<boolean> | boolean | void;
} = {}) {
  const onReply = over.onReply ?? mock(async (_id: unknown, _optionId?: string) => {});
  const onAutoApproveChange = over.onAutoApproveChange ?? mock((_v: boolean) => {});
  const onAllowAllMode = over.onAllowAllMode ?? mock(async () => true);
  const result = render(
    // Mirrors `app/layout.tsx`, which wraps the whole tree in a
    // `TooltipProvider` — the row's overflow-menu trigger uses `Hint`.
    <TooltipProvider>
      <PermissionPrompt
        projectId="proj_1"
        sessionId="sess_1"
        permissions={over.permissions ?? []}
        autoApprove={over.autoApprove ?? false}
        onAutoApproveChange={onAutoApproveChange}
        onReply={onReply as never}
        onAllowAllMode={onAllowAllMode as never}
      />
    </TooltipProvider>,
  );
  return { ...result, onReply, onAutoApproveChange, onAllowAllMode };
}

/** Open a row's scope menu and pick an entry. Radix opens on `pointerdown`,
 *  which happy-dom does not synthesize from `fireEvent.click` — the keyboard
 *  path is both real and the one an assistive-tech user takes. */
async function chooseScope(itemIndex: number, rowIndex = 0) {
  const triggers = screen.getAllByTestId('permission-scope-trigger');
  fireEvent.keyDown(triggers[rowIndex]!, { key: 'Enter' });
  const items = await screen.findAllByRole('menuitemradio');
  fireEvent.click(items[itemIndex]!);
  await flush();
}

/** Menu item indices. The same "All <noun>" label deliberately appears in the
 *  session and project tiers — the GROUP heading supplies the duration — so
 *  these are positional by necessity, not laziness. */
const SCOPE = {
  once: 0,
  sessionTool: 1,
  sessionAll: 2,
  projectTool: 3,
  projectReads: 4,
  projectAll: 5,
} as const;

/** The scope menu's trigger label — the surface's answer to "how long?". */
function scopeTrigger(rowIndex = 0) {
  return screen.getAllByTestId('permission-scope-trigger')[rowIndex]!;
}

/** The command line, reassembled from the spans `CommandLine` splits it into. */
function commandLineText() {
  return document.querySelector('code')?.textContent ?? null;
}

describe('PermissionPrompt — zero amber', () => {
  it('never renders an amber-* class anywhere in its DOM', () => {
    const { container } = renderPrompt({ permissions: [BASH_PERMISSION] });
    expect(container.innerHTML).not.toContain('amber');
  });
});

describe('PermissionPrompt — two-button decision', () => {
  it('offers exactly one skip and one primary button, in that order, per row', () => {
    renderPrompt({ permissions: [BASH_PERMISSION] });
    const labels = screen
      .getAllByRole('button')
      .map((btn) => btn.textContent?.trim())
      .filter((text): text is string => !!text && ['Skip', 'Run', 'Allow'].includes(text));
    expect(labels).toEqual(['Skip', 'Run']);
  });

  // You *run* a command; you *allow* a file read. A button that says "Run"
  // over a read request has stopped describing its own action.
  it('says Run for a command and Allow for everything else', () => {
    renderPrompt({ permissions: [BASH_PERMISSION, READ_PERMISSION] });
    const primaries = screen
      .getAllByTestId('acp-permission-allow-once')
      .map((b) => b.textContent?.trim());
    expect(primaries).toEqual(['Run', 'Allow']);
  });

  it('states the request in plain language, not the raw harness tool name', () => {
    renderPrompt({ permissions: [BASH_PERMISSION] });
    // The harness sent `Bash`; a non-technical user is shown what it DOES.
    expect(screen.getByText('Run a command')).toBeTruthy();
    expect(screen.queryByText('Bash')).toBeNull();
    // The concrete target stays visible — the answer is meaningless without it.
    expect(commandLineText()).toBe('$\u00a0rm -rf /tmp/x');
  });

  // A shell command should look like one. The `$` is `select-none` so copying
  // the line yields the command, not the prompt marker.
  it('renders a command with a $ prompt marker and the program name emphasised', () => {
    const { container } = renderPrompt({ permissions: [BASH_PERMISSION] });

    const code = container.querySelector('code')!;
    const [marker, program] = [...code.querySelectorAll('span')];
    expect(marker!.textContent).toBe('$\u00a0');
    expect(marker!.className).toContain('select-none');
    expect(program!.textContent).toBe('rm');
  });

  it('the primary button answers with allow_once at the default scope', async () => {
    const { onReply } = renderPrompt({ permissions: [BASH_PERMISSION] });

    fireEvent.click(screen.getByTestId('acp-permission-allow-once'));
    await flush();

    expect(onReply).toHaveBeenCalledWith('p-bash', 'allow_once');
    expect(rememberToolDecisionMock).not.toHaveBeenCalled();
  });

  // Stacked requests otherwise expose "Allow", "Allow", "Allow" to a screen
  // reader with nothing to tell them apart. The accessible name still
  // CONTAINS the visible label, per WCAG 2.5.3 (Label in Name).
  it('names each button after the request it answers, for stacked rows', () => {
    renderPrompt({ permissions: [BASH_PERMISSION, READ_PERMISSION] });

    expect(screen.getByRole('button', { name: 'Run — Run a command' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Skip — Run a command' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Allow — Read a file' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Read a file' })).toBeTruthy();
  });

  it('Skip answers with the deny option', async () => {
    const { onReply } = renderPrompt({ permissions: [BASH_PERMISSION] });

    fireEvent.click(screen.getByTestId('acp-permission-deny'));
    await flush();

    expect(onReply).toHaveBeenCalledWith('p-bash', 'reject_once');
    expect(rememberToolDecisionMock).not.toHaveBeenCalled();
  });
});

describe('PermissionPrompt — the scope menu carries every duration an answer can have', () => {
  // Verified against the two prompts this component replaced (git
  // `2312edf97^`): "Allow once", "Allow for session" and "Allow everything"
  // all existed, plus `Always allow "slug.tool"` on the connector side. The
  // checkbox that briefly replaced them could express one scope, so the rest
  // were unreachable until this menu.
  it('offers once / session / project tiers, defaulting to once', async () => {
    renderPrompt({ permissions: [BASH_PERMISSION] });
    expect(scopeTrigger().textContent).toContain('Just once');

    fireEvent.keyDown(scopeTrigger(), { key: 'Enter' });
    const items = (await screen.findAllByRole('menuitemradio')).map((i) => i.textContent?.trim());
    expect(items).toEqual([
      'Just this once',
      'All commands',
      'Everything',
      'All commands',
      'Anything that only reads',
      'Everything',
    ]);
  });

  // Regression for the control this lineage started with: the old `Switch`
  // persisted `toolDecisions[tool] = 'allow'` the instant it was flipped,
  // which the policy auto-answer effect then turned into a silent approval.
  // Choosing a scope must never itself be an answer.
  it('choosing a scope answers nothing and persists nothing on its own', async () => {
    const { onReply } = renderPrompt({ permissions: [BASH_PERMISSION] });

    await chooseScope(SCOPE.sessionTool);

    expect(onReply).not.toHaveBeenCalled();
    expect(rememberToolDecisionMock).not.toHaveBeenCalled();
    expect(setAutoApproveMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('permission-record-row')).toBeNull();
  });

  it('session · this tool replies with the harness allow_always option', async () => {
    const { onReply } = renderPrompt({ permissions: [BASH_PERMISSION] });

    await chooseScope(SCOPE.sessionTool);
    expect(scopeTrigger().textContent).toContain('This session');
    fireEvent.click(screen.getByTestId('acp-permission-allow-once'));
    await flush();

    expect(onReply).toHaveBeenCalledWith('p-bash', 'allow_always');
    // Session scope is the harness's own; nothing is written to the project.
    expect(rememberToolDecisionMock).not.toHaveBeenCalled();
  });

  it('project · this tool writes toolDecisions under the canonical key', async () => {
    const { onReply } = renderPrompt({ permissions: [BASH_PERMISSION] });

    await chooseScope(SCOPE.projectTool);

    expect(scopeTrigger().textContent).toContain('This project');
    fireEvent.click(screen.getByTestId('acp-permission-allow-once'));
    await flush();

    expect(onReply).toHaveBeenCalledWith('p-bash', 'allow_always');
    expect(rememberToolDecisionMock).toHaveBeenCalledWith('bash', 'allow');
  });

  it('project · reads sets the autoApprove mode AND still answers this request', async () => {
    const { onReply } = renderPrompt({ permissions: [BASH_PERMISSION] });

    await chooseScope(SCOPE.projectReads);
    fireEvent.click(screen.getByTestId('acp-permission-allow-once'));
    await flush();

    expect(setAutoApproveMock).toHaveBeenCalledWith('reads');
    // The trap this guards: "reads" would not cover a bash request, so a
    // scope choice that left the agent blocked would be a dead end.
    expect(onReply).toHaveBeenCalledWith('p-bash', 'allow_once');
  });

  it('blanket scopes are confirmed before they take effect', async () => {
    const { onReply, onAutoApproveChange } = renderPrompt({ permissions: [BASH_PERMISSION] });

    await chooseScope(SCOPE.sessionAll);

    fireEvent.click(screen.getByTestId('acp-permission-allow-once'));
    await flush();

    // Nothing happened yet — the dialog is in the way.
    expect(onReply).not.toHaveBeenCalled();
    expect(onAutoApproveChange).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Allow everything for the rest of this session?')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Allow everything' }));
    await flush();

    expect(onReply).toHaveBeenCalledWith('p-bash', 'allow_once');
    expect(onAutoApproveChange).toHaveBeenCalledWith(true);
  });

  // The per-row `session-all` ("Everything this session") scope is the same
  // bypass-all intent as the header's "Allow all", so it must flip the harness
  // mode too — not just the client-side backstop, which only answers requests
  // that still ARRIVE.
  it('the per-row session · everything scope flips bypass mode too', async () => {
    const onAllowAllMode = mock(async () => true);
    const { onReply, onAutoApproveChange } = renderPrompt({
      permissions: [BASH_PERMISSION],
      onAllowAllMode,
    });

    await chooseScope(SCOPE.sessionAll);
    fireEvent.click(screen.getByTestId('acp-permission-allow-once'));
    await flush();
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Allow everything' }),
    );
    await flush();

    expect(onAllowAllMode).toHaveBeenCalledTimes(1);
    expect(onAutoApproveChange).toHaveBeenCalledWith(true);
    expect(onReply).toHaveBeenCalledWith('p-bash', 'allow_once');
  });

  it('Skip stays once-only no matter what scope is selected', async () => {
    const { onReply } = renderPrompt({ permissions: [BASH_PERMISSION] });

    await chooseScope(SCOPE.projectTool);

    fireEvent.click(screen.getByTestId('acp-permission-deny'));
    await flush();

    expect(onReply).toHaveBeenCalledWith('p-bash', 'reject_once');
    // The menu scopes the ALLOW. Putting "block everything forever" two
    // clicks away, next to the most permissive option, would be a trap.
    expect(rememberToolDecisionMock).not.toHaveBeenCalled();
    expect(setAutoApproveMock).not.toHaveBeenCalled();
  });

  it('does not persist when the answer itself failed', async () => {
    const onReply = mock(async () => {
      throw new Error('network blip');
    });
    renderPrompt({ permissions: [BASH_PERMISSION], onReply });

    await chooseScope(SCOPE.projectTool);

    fireEvent.click(screen.getByTestId('acp-permission-allow-once'));
    await flush();

    expect(rememberToolDecisionMock).not.toHaveBeenCalled();
  });
});

describe('PermissionPrompt — extra harness options live behind the overflow menu', () => {
  it('keeps the row at two buttons and answers with the extra option when picked', async () => {
    const { onReply } = renderPrompt({ permissions: [EXTRA_OPTION_PERMISSION] });

    // Not inline — the row stays a binary question.
    expect(screen.queryByRole('button', { name: 'Allow everything in this folder' })).toBeNull();

    // Radix opens the menu on `pointerdown`, which happy-dom does not
    // synthesize from `fireEvent.click` — the keyboard path is both real and
    // the one an assistive-tech user takes.
    fireEvent.keyDown(screen.getByRole('button', { name: 'More options' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Allow everything in this folder' }));
    await flush();

    expect(onReply).toHaveBeenCalledWith('p-edit', 'allow_dir');
  });

  it('renders no overflow trigger when the harness offered no extra options', () => {
    renderPrompt({ permissions: [BASH_PERMISSION] });
    expect(screen.queryByRole('button', { name: 'More options' })).toBeNull();
  });
});

describe('PermissionPrompt — "Allow all" only when requests are stacked', () => {
  it('is hidden for a single request', () => {
    renderPrompt({ permissions: [BASH_PERMISSION] });
    expect(screen.queryByRole('button', { name: 'Allow all' })).toBeNull();
  });

  it('does not call onReply until the confirmation is accepted', async () => {
    const { onReply } = renderPrompt({ permissions: [BASH_PERMISSION, READ_PERMISSION] });

    fireEvent.click(screen.getByRole('button', { name: 'Allow all' }));
    await flush();

    expect(onReply).not.toHaveBeenCalled();
    expect(screen.getByText('Allow everything for the rest of this session?')).toBeTruthy();

    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Allow everything' }));
    await flush();

    expect(onReply).toHaveBeenCalledWith('p-bash', 'allow_once');
    expect(onReply).toHaveBeenCalledWith('p-read', 'allow_once');
  });

  it('records each bulk-replied row after its own reply resolves', async () => {
    renderPrompt({ permissions: [BASH_PERMISSION, READ_PERMISSION] });

    fireEvent.click(screen.getByRole('button', { name: 'Allow all' }));
    await flush();
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Allow everything' }));
    await flush();

    expect(screen.getAllByTestId('permission-record-row').length).toBe(2);
    expect(screen.getByText(/Allowed — Run a command/)).toBeTruthy();
  });

  // The "even when I click Allow everything it doesn't work" fix: resolving
  // only the currently-pending requests is not enough — the running turn keeps
  // generating fresh ones. "Allow all" must ALSO flip the whole session to its
  // most-permissive advertised mode, so the harness STOPS asking.
  it('flips the session to bypass mode (onAllowAllMode) AND resolves every pending request', async () => {
    const onAllowAllMode = mock(async () => true);
    const { onReply, onAutoApproveChange } = renderPrompt({
      permissions: [BASH_PERMISSION, READ_PERMISSION],
      onAllowAllMode,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Allow all' }));
    await flush();
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Allow everything' }));
    await flush();

    expect(onAllowAllMode).toHaveBeenCalledTimes(1);
    expect(onAutoApproveChange).toHaveBeenCalledWith(true);
    expect(onReply).toHaveBeenCalledWith('p-bash', 'allow_once');
    expect(onReply).toHaveBeenCalledWith('p-read', 'allow_once');
  });

  // A harness that advertises no permissive mode (onAllowAllMode → false, or
  // throwing) still has the client-side backstop + the per-request replies.
  it('still resolves pending requests when no mode switch is available', async () => {
    const onAllowAllMode = mock(async () => false);
    const { onReply } = renderPrompt({
      permissions: [BASH_PERMISSION, READ_PERMISSION],
      onAllowAllMode,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Allow all' }));
    await flush();
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Allow everything' }),
    );
    await flush();

    expect(onAllowAllMode).toHaveBeenCalledTimes(1);
    expect(onReply).toHaveBeenCalledWith('p-bash', 'allow_once');
    expect(onReply).toHaveBeenCalledWith('p-read', 'allow_once');
  });
});

describe('PermissionPrompt — rows answer independently', () => {
  // The old surface used a single `busy` string, so answering one row
  // disabled every other row's buttons for the whole round trip. The ACP ids
  // are independent JSON-RPC calls; a stack of requests should stay usable.
  it('an in-flight row does not disable the other rows', async () => {
    let release: (() => void) | undefined;
    const onReply = mock(
      (id: unknown) =>
        id === 'p-bash'
          ? new Promise<void>((resolve) => {
              release = resolve;
            })
          : Promise.resolve(),
    );
    renderPrompt({ permissions: [BASH_PERMISSION, READ_PERMISSION], onReply });

    const [bashAllow, readAllow] = screen.getAllByTestId('acp-permission-allow-once');
    fireEvent.click(bashAllow!);
    await flush();

    expect(bashAllow!.hasAttribute('disabled')).toBe(true);
    expect(readAllow!.hasAttribute('disabled')).toBe(false);

    release?.();
    await flush();
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

  // An auto-answer is the user's EARLIER decision being honoured. Narrating
  // it flashed a row for ~2s that they never asked for and could not act on;
  // paired with the pending row being suppressed, a covered request now
  // produces no UI at all — which is what configuring the policy was for.
  it('produces no UI at all — no prompt row, no record row', async () => {
    currentPolicy = { autoApprove: 'none', toolDecisions: { Bash: 'allow' } };
    const { container, onReply } = renderPrompt({ permissions: [BASH_PERMISSION] });
    await flush();

    expect(onReply).toHaveBeenCalledWith('p-bash', 'allow_once');
    expect(screen.queryByTestId('permission-decision-row')).toBeNull();
    expect(screen.queryByTestId('permission-record-row')).toBeNull();
    expect(container.innerHTML).toBe('');
  });

  // The flash Jay reported: the row used to mount, paint Skip/Run, and
  // unmount once the async answer landed. Suppression has to be synchronous.
  it('never paints a prompt for a request the session backstop will answer', () => {
    const { container } = renderPrompt({ permissions: [BASH_PERMISSION], autoApprove: true });

    expect(screen.queryByTestId('permission-decision-row')).toBeNull();
    expect(screen.queryByTestId('acp-permission-allow-once')).toBeNull();
    expect(container.innerHTML).toBe('');
  });

  it('never paints a prompt under autoApprove: "all"', () => {
    currentPolicy = { autoApprove: 'all', toolDecisions: {} };
    renderPrompt({ permissions: [BASH_PERMISSION] });

    expect(screen.queryByTestId('permission-decision-row')).toBeNull();
  });

  it('still paints a prompt for a request no policy covers', () => {
    currentPolicy = { autoApprove: 'reads', toolDecisions: {} };
    renderPrompt({ permissions: [BASH_PERMISSION] });

    expect(screen.getByTestId('permission-decision-row')).toBeTruthy();
  });

  // WS5-P1-c review, Important #3: the auto-answer effect must not record
  // "Allowed"/"Denied" before `onReply` actually resolves — a transient
  // failure would otherwise show a false-positive record for a request the
  // agent never actually got an answer to.
  it('a failed auto-answer records nothing and shows an error toast', async () => {
    currentPolicy = { autoApprove: 'reads', toolDecisions: {} };
    const onReply = mock(async (_id: unknown, _optionId?: string) => {
      throw new Error('network blip');
    });
    renderPrompt({ permissions: [READ_PERMISSION], onReply });
    await flush();

    expect(onReply).toHaveBeenCalledWith('p-read', 'allow_once');
    // A request the agent never actually got an answer to must never look
    // resolved — no false "Allowed" record.
    expect(screen.queryByTestId('permission-record-row')).toBeNull();
  });
});

describe('PermissionPrompt — connector rows share the one contract', () => {
  it('asks in the same shape as an ACP row, with the tool path as the detail', () => {
    connectorActions = [CONNECTOR_ACTION];
    renderPrompt();

    expect(screen.getByText('Use linear')).toBeTruthy();
    expect(screen.getByText('linear.create_issue')).toBeTruthy();
    expect(screen.getByTestId('acp-permission-allow-once')).toBeTruthy();
    expect(screen.getByTestId('acp-permission-deny')).toBeTruthy();
  });

  it('hides the project tier from members who cannot write project policies', async () => {
    connectorActions = [CONNECTOR_ACTION];
    canWritePolicies = false;
    renderPrompt();

    fireEvent.keyDown(scopeTrigger(), { key: 'Enter' });
    const groups = (await screen.findAllByRole('menuitemradio')).map((i) => i.textContent?.trim());
    // once + the two session entries, and nothing project-scoped.
    expect(groups).toEqual(['Just this once', 'All linear.create_issue', 'Everything']);
  });

  it('maps the session tiers onto the mutation\'s own scope vocabulary', async () => {
    connectorActions = [CONNECTOR_ACTION];
    canWritePolicies = true;
    renderPrompt();

    await chooseScope(SCOPE.sessionTool);
    fireEvent.click(screen.getByTestId('acp-permission-allow-once'));
    await flush();

    // The connector mutation's own vocabulary — `session`, not the menu's
    // internal `session-tool`.
    expect(resolveConnectorMutateMock.mock.calls[0]?.[0]).toEqual({
      executionId: 'exec-1',
      decision: 'approve',
      scope: 'session',
    });
  });

  it('project · this tool writes an always_run policy after the approval resolves', async () => {
    connectorActions = [CONNECTOR_ACTION];
    canWritePolicies = true;
    renderPrompt();

    await chooseScope(SCOPE.projectTool);

    fireEvent.click(screen.getByTestId('acp-permission-allow-once'));
    await flush();
    await flush();

    expect(setProjectPoliciesMock).toHaveBeenCalledWith(
      'proj_1',
      [{ match: 'linear.create_issue', action: 'always_run' }],
      'risk',
    );
  });

  it('Skip never writes a policy, whatever scope is selected', async () => {
    connectorActions = [CONNECTOR_ACTION];
    canWritePolicies = true;
    renderPrompt();

    await chooseScope(SCOPE.projectTool);

    fireEvent.click(screen.getByTestId('acp-permission-deny'));
    await flush();
    await flush();

    expect(setProjectPoliciesMock).not.toHaveBeenCalled();
  });

  it('writes no policy at the default once scope', async () => {
    connectorActions = [CONNECTOR_ACTION];
    canWritePolicies = true;
    renderPrompt();

    fireEvent.click(screen.getByTestId('acp-permission-allow-once'));
    await flush();
    await flush();

    expect(setProjectPoliciesMock).not.toHaveBeenCalled();
  });
});

describe('PermissionPrompt — answered record row', () => {
  it('Allow swaps the row for a compact answered record', async () => {
    renderPrompt({ permissions: [BASH_PERMISSION] });

    fireEvent.click(screen.getByTestId('acp-permission-allow-once'));
    await flush();

    expect(screen.getByTestId('permission-record-row')).toBeTruthy();
    expect(screen.getByText(/Allowed — Run a command/)).toBeTruthy();
  });

  it('names the scope the answer was given at', async () => {
    renderPrompt({ permissions: [BASH_PERMISSION] });

    await chooseScope(SCOPE.projectTool);
    fireEvent.click(screen.getByTestId('acp-permission-allow-once'));
    await flush();

    expect(screen.getByText(/always in this project/)).toBeTruthy();
  });
});

describe('PermissionPrompt — session auto-approve is not this surface\'s business', () => {
  // The strip used to keep an empty bordered card pinned above the composer
  // with nothing in it but one line of status. A session-wide MODE is not a
  // pending request; it now lives in the session header's More-actions menu.
  it('renders nothing at all when auto-approve is on and nothing is pending', () => {
    const { container } = renderPrompt({ autoApprove: true });

    expect(container.innerHTML).toBe('');
    expect(screen.queryByTestId('acp-session-permission-autoapprove')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Turn off' })).toBeNull();
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

describe('PermissionPrompt — describePermission', () => {
  it('normalizes harness casing and falls back to the raw kind for unknown tools', async () => {
    const { describePermission } = await import('./permission-prompt');

    expect(describePermission({ ...BASH_PERMISSION, permission: 'bash' })).toEqual({
      label: 'Run a command',
      mono: false,
      scope: 'commands',
      isCommand: true,
    });
    expect(describePermission({ ...BASH_PERMISSION, permission: 'BASH' }).label).toBe('Run a command');
    expect(describePermission({ ...BASH_PERMISSION, permission: 'wobble' })).toEqual({
      label: 'wobble',
      mono: false,
      scope: 'wobble',
      isCommand: false,
    });
  });

  // `acp/reduce.ts` ranks `params.title` ABOVE `toolCall.kind`, so a harness
  // that titles its requests puts the whole invocation in `permission`.
  it('treats a whitespace-bearing identifier as a one-off command, not a tool id', async () => {
    const { describePermission } = await import('./permission-prompt');

    expect(describePermission(RAW_COMMAND_PERMISSION)).toEqual({
      label: 'mkdir -p /workspace/jay-suthar-portfolio/assets',
      mono: true,
      scope: 'mkdir',
      isCommand: true,
    });
  });
});

describe('policyKeyFor / rememberedDecision', () => {
  it('collapses a titled invocation to its command name and lowercases a kind', async () => {
    const { policyKeyFor } = await import('./permission-prompt');

    expect(policyKeyFor('mkdir -p /workspace/jay-suthar-portfolio/assets')).toBe('mkdir');
    expect(policyKeyFor('Bash')).toBe('bash');
    expect(policyKeyFor('  read  ')).toBe('read');
  });

  it('reads a decision back through the raw, lowercase, and canonical keys', async () => {
    const { rememberedDecision } = await import('./permission-prompt');

    // Canonical (what is written today).
    expect(rememberedDecision({ mkdir: 'allow' }, 'mkdir -p /tmp/x')).toBe('allow');
    // Legacy raw-string keys written before `policyKeyFor` existed.
    expect(rememberedDecision({ Bash: 'deny' }, 'Bash')).toBe('deny');
    expect(rememberedDecision({ bash: 'allow' }, 'Bash')).toBe('allow');
    expect(rememberedDecision({}, 'Bash')).toBeUndefined();
  });
});

describe('PermissionPrompt — harness sent a raw command instead of a tool kind', () => {
  it('renders the command as code, not as a sans-serif tool name', () => {
    const { container } = renderPrompt({ permissions: [RAW_COMMAND_PERMISSION] });

    const code = container.querySelector('code')!;
    expect(code.textContent).toBe('$\u00a0mkdir -p /workspace/jay-suthar-portfolio/assets');
    expect(screen.getByTestId('acp-permission-allow-once').textContent?.trim()).toBe('Run');
  });

  // Regression for the bug this shipped with: keying the policy on the whole
  // invocation could never match twice, so the row hid the checkbox rather
  // than lie. Keying on the command NAME makes it work, so it is shown.
  it('scopes the menu to the command name', async () => {
    renderPrompt({ permissions: [RAW_COMMAND_PERMISSION] });

    fireEvent.keyDown(scopeTrigger(), { key: 'Enter' });
    const items = (await screen.findAllByRole('menuitemradio')).map((i) => i.textContent?.trim());
    expect(items).toContain('All mkdir');
  });

  it('remembers the decision under the command name, not the whole invocation', async () => {
    renderPrompt({ permissions: [RAW_COMMAND_PERMISSION] });

    await chooseScope(SCOPE.projectTool);
    fireEvent.click(screen.getByTestId('acp-permission-allow-once'));
    await flush();

    expect(rememberToolDecisionMock).toHaveBeenCalledWith('mkdir', 'allow');
  });

  it('auto-answers a LATER, differently-argued command from that saved decision', async () => {
    currentPolicy = { autoApprove: 'none', toolDecisions: { mkdir: 'allow' } };
    const { onReply } = renderPrompt({
      permissions: [{ ...RAW_COMMAND_PERMISSION, id: 'p-raw-2', permission: 'mkdir -p /somewhere/else' }],
    });
    await flush();

    // The whole point: a second `mkdir` with different arguments never
    // reaches the user. Under the old exact-key matching this stayed pending.
    expect(onReply).toHaveBeenCalledWith('p-raw-2', 'allow_once');
  });

  it('shows no placeholder glyph beside the command', () => {
    const { container } = renderPrompt({ permissions: [RAW_COMMAND_PERMISSION] });

    // The row used to render a grey question-mark shield tile directly under
    // the yellow header one. What is left is the header shield plus the scope
    // menu's chevron — both load-bearing, neither a stand-in for a missing icon.
    const icons = [...container.querySelectorAll('svg')].map((s) => s.getAttribute('class'));
    expect(icons.length).toBe(2);
    expect(icons.some((c) => c?.includes('shield'))).toBe(true);
    expect(icons.some((c) => c?.includes('chevron-down'))).toBe(true);
  });
});

describe('PermissionPrompt — empty state', () => {
  it('renders nothing when there is no pending permission, no connector action, and autoApprove is off', () => {
    const { container } = renderPrompt();
    expect(container.innerHTML).toBe('');
  });
});
