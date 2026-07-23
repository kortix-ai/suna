import type { HarnessAuthKind } from '@kortix/sdk/projects-client';
import type { ModelsPageConnection } from '@kortix/sdk/react';

// Same `@happy-dom/global-registrator` + dynamic-import dance
// `connect-modal-host.test.tsx` establishes — a static
// `import { screen } from '@testing-library/react'` evaluates before
// `GlobalRegistrator` registers (ESM hoists static imports), leaving `screen`
// stuck on its permanently-throwing "no document" stub. Only dynamic
// `import()` under top-level `await` forces registration first.
const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
delete (globalThis as any).window;
delete (globalThis as any).document;
GlobalRegistrator.register();

const { afterAll, afterEach, describe, expect, mock, test } = await import('bun:test');
const { cleanup, render, screen, within } = await import('@testing-library/react');
const ReactModule = await import('react');

// The two-door LIST never mounts a form, so no react-query is needed for these
// tests; a form only appears once a method is picked (covered by the host
// suite's deep-link tests). `ProviderLogo` still renders `next/image`, whose
// `getImgProps` builds a `URL` from a relative asset path happy-dom can't
// resolve — same stub the sibling suites use.
mock.module('next/image', () => ({
  default: (props: Record<string, unknown>) => {
    const { src, alt, ...rest } = props;
    return ReactModule.createElement('img', { src, alt, ...rest });
  },
}));

const { ConnectModelModal } = await import('./connect-model-modal');
const { accountDoorProviders } = await import('@kortix/shared/auth-providers');
const { LLM_PROVIDERS } = await import('@/lib/llm-providers');

function connection(
  over: Partial<ModelsPageConnection> & { id: HarnessAuthKind },
): ModelsPageConnection {
  return {
    name: over.name ?? 'Connection',
    kind: over.id,
    status: 'ready',
    usedBy: [],
    catalogState: 'available',
    modelCount: 1,
    statusReason: null,
    ...over,
  };
}

function renderModal(props: Partial<Parameters<typeof ConnectModelModal>[0]> = {}) {
  return render(
    ReactModule.createElement(ConnectModelModal, {
      projectId: 'proj_1',
      open: true,
      onOpenChange: () => {},
      runtimes: [],
      connections: [],
      connectedProviderIds: [],
      ...props,
    }),
  );
}

afterEach(() => cleanup());
afterAll(() => GlobalRegistrator.unregister());

describe('ConnectModelModal — two doors, built from the shared registry', () => {
  test('renders both door headers and the title copy', () => {
    renderModal();
    expect(screen.getByText('Connect a model service')).toBeDefined();
    expect(screen.getByText('Sign in with an account')).toBeDefined();
    expect(screen.getByText('Use an API key')).toBeDefined();
  });

  test('the account door renders exactly the registry account-door providers — nothing hardcoded', () => {
    renderModal();
    const accountSection = screen.getByText('Sign in with an account').closest('section');
    expect(accountSection).not.toBeNull();
    const door = within(accountSection as HTMLElement);
    // Every account-door row comes from the registry, so its label must show...
    for (const provider of accountDoorProviders()) {
      expect(door.getByText(provider.label)).toBeDefined();
    }
    // ...the account door has exactly as many rows as the registry declares...
    expect((accountSection as HTMLElement).querySelectorAll('li').length).toBe(
      accountDoorProviders().length,
    );
    // ...and Phase-2 account providers absent from the registry (Copilot, xAI)
    // must NOT appear as account rows. (xAI still exists as an API-key BYOK
    // provider in the catalog — that's a different door, which is exactly why
    // this assertion is scoped to the account section.)
    expect(door.queryByText(/Copilot/)).toBeNull();
    expect(door.queryByText(/xAI/)).toBeNull();
  });

  test('account rows show the honest web flow method (paste vs device code)', () => {
    renderModal();
    // Claude Code is paste-token on web; ChatGPT/Codex is device-code.
    expect(screen.getByText('Paste a setup token')).toBeDefined();
    expect(screen.getByText(/Sign in with a device code/)).toBeDefined();
    // The device-code row also fans out its honest "works with" harness set.
    expect(screen.getByText(/works with Codex/)).toBeDefined();
  });

  test('a ready connection shows a Connected badge on its row', () => {
    renderModal({
      connections: [connection({ id: 'claude_subscription', name: 'Claude', status: 'ready' })],
    });
    const claudeRow = screen.getByText('Claude Code').closest('button');
    expect(claudeRow).not.toBeNull();
    expect(within(claudeRow as HTMLElement).getByText('Connected')).toBeDefined();
  });

  test('a needs-attention connection shows the badge AND the reason as the row subtitle (the next action)', () => {
    renderModal({
      connections: [
        connection({
          id: 'codex_subscription',
          name: 'ChatGPT',
          status: 'needs-attention',
          statusReason: 'Token expired',
        }),
      ],
    });
    const codexRow = screen.getByText('ChatGPT / Codex').closest('button');
    expect(codexRow).not.toBeNull();
    expect(within(codexRow as HTMLElement).getByText('Needs attention')).toBeDefined();
    expect(within(codexRow as HTMLElement).getByText(/Token expired/)).toBeDefined();
  });

  test('a raw catalog key marks its row Connected purely from connectedProviderIds', () => {
    const other = LLM_PROVIDERS.find(
      (p) => !['claude-subscription', 'codex', 'anthropic', 'openai', 'kortix'].includes(p.id),
    );
    if (!other) throw new Error('expected at least one raw catalog provider in the seed');
    renderModal({ connectedProviderIds: [other.id] });
    const row = screen.getByText(other.label).closest('button');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('Connected')).toBeDefined();
  });

  test('harnessFilter NEVER hides a door or a row — it only emphasizes the compatible method', () => {
    // The old behavior filtered the account door down to `claude`-compatible
    // providers, dropping the Codex row. The unified modal keeps BOTH doors and
    // BOTH account rows and instead marks the compatible one "Recommended".
    renderModal({ harnessFilter: 'claude' });
    expect(screen.getByText('Sign in with an account')).toBeDefined();
    expect(screen.getByText('Use an API key')).toBeDefined();

    const claudeRow = screen.getByText('Claude Code').closest('button');
    const codexRow = screen.getByText('ChatGPT / Codex').closest('button');
    expect(claudeRow).not.toBeNull();
    expect(codexRow).not.toBeNull();
    // Claude Code is what a `claude` harness can use → emphasized.
    expect(within(claudeRow as HTMLElement).getByText('Recommended')).toBeDefined();
    // Codex is still shown (never hidden), just not recommended for `claude`.
    expect(within(codexRow as HTMLElement).queryByText('Recommended')).toBeNull();
  });

  test('both doors ALWAYS render regardless of the tab prop — no api-key-only variant', () => {
    // `tab` is deprecated and no longer narrows the modal. Whether a caller
    // passes 'api-keys', 'subscriptions', or nothing, the same two-door surface
    // renders everywhere (the owner\'s "always use the same modal" fix).
    for (const tab of ['api-keys', 'subscriptions', null] as const) {
      const { unmount } = render(
        ReactModule.createElement(ConnectModelModal, {
          projectId: 'proj_1',
          open: true,
          onOpenChange: () => {},
          runtimes: [],
          connections: [],
          connectedProviderIds: [],
          tab,
        }),
      );
      expect(screen.getByText('Sign in with an account')).toBeDefined();
      expect(screen.getByText('Use an API key')).toBeDefined();
      unmount();
    }
  });
});
