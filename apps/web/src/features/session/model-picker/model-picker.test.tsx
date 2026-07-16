import type { HarnessAuthKind } from '@kortix/sdk/projects-client';
import type { ModelPickerViewModel } from '@kortix/sdk/react';

// `@testing-library/dom` decides at *module-evaluation* time whether `screen`
// is bound to real DOM queries or a permanently-throwing stub (see
// `screen.js`'s `typeof document === 'undefined'` check baked into the
// export). ESM hoists every static `import` above ordinary statements, so a
// plain `import { GlobalRegistrator } from '@happy-dom/global-registrator';
// GlobalRegistrator.register();` followed by `import { screen } from
// '@testing-library/react'` still evaluates testing-library BEFORE the
// registration call, and `screen` gets stuck on the throwing stub. Dynamic
// `import()` inside top-level `await` is the only way to force registration
// to run first — this is this repo's first component test needing a real
// DOM (Radix `Popover`'s content portals to `document.body`, which silently
// no-ops under this directory's usual `react-test-renderer` harness — see
// `acp-config-controls.test.tsx`), so there is no existing local precedent.
const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
// A sibling suite (`acp-config-controls.test.tsx`) installs a bare
// `globalThis.window = globalThis` / fake `document` stub — harmless for its
// own `react-test-renderer` harness, but if that file runs first in the same
// `bun test` process, `GlobalRegistrator.register()` sees those globals as
// already defined and skips installing a *real* document, so Radix's
// `Popover.Portal` (which needs an actual `document.body` to portal into)
// silently has nowhere real to mount. Clear them first so this file always
// gets a genuine happy-dom window/document regardless of run order.
delete (globalThis as any).window;
delete (globalThis as any).document;
GlobalRegistrator.register();

const { afterAll, afterEach, describe, expect, it, mock } = await import('bun:test');
const { act, cleanup, fireEvent, render, screen, within } = await import('@testing-library/react');
const { TooltipProvider } = await import('@/components/ui/tooltip');
const { ModelPicker } = await import('./model-picker');

afterEach(() => {
  cleanup();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

function buildVm(over: Partial<ModelPickerViewModel> = {}): ModelPickerViewModel {
  return {
    status: 'ready',
    selectedKey: 'anthropic:claude-sonnet-5',
    searchable: false,
    trigger: { label: 'Claude Sonnet 5', sublabel: 'via Subscription', interactive: true },
    customEntry: {
      allowed: true,
      placeholder: 'e.g. claude-sonnet-4-6',
      validate: (id: string) => (id ? { ok: true } : { ok: false, reason: 'Enter a model id' }),
    },
    groups: [
      {
        id: 'anthropic',
        label: 'Anthropic',
        connectAction: null,
        items: [
          {
            key: 'anthropic:claude-sonnet-5',
            kind: 'model',
            label: 'Claude Sonnet 5',
            sublabel: 'via Subscription',
            providerId: 'anthropic',
            experimental: true,
            liveSwap: true,
            selectable: true,
          },
        ],
      },
      {
        id: 'not-connected',
        label: 'Not connected',
        connectAction: { connectionId: 'codex_subscription' as HarnessAuthKind, label: 'Connect' },
        items: [
          {
            key: 'openai:gpt-5.1',
            kind: 'model',
            label: 'GPT-5.1',
            sublabel: 'Codex (ChatGPT)',
            providerId: 'openai',
            experimental: true,
            liveSwap: false,
            selectable: false,
          },
        ],
      },
    ],
    select: mock(() => {}),
    ...over,
  };
}

function renderPicker(vm: ModelPickerViewModel, onConnect = mock((_id: HarnessAuthKind) => {})) {
  render(
    <TooltipProvider>
      <ModelPicker vm={vm} onConnect={onConnect} />
    </TooltipProvider>,
  );
  return { onConnect };
}

// Radix `Popper`'s content measures its own position in an effect that
// settles a tick after a synchronous `act()` block returns — flush it after
// every interaction that can toggle the popover, so no caller sees an
// "update not wrapped in act()" warning from a later, uncontrolled commit.
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function openPicker(vm: ModelPickerViewModel, onConnect?: ReturnType<typeof mock>) {
  const utils = renderPicker(
    vm,
    onConnect as ReturnType<typeof mock<(id: HarnessAuthKind) => void>>,
  );
  fireEvent.click(screen.getByRole('button', { name: /Claude Sonnet 5/i }));
  await flush();
  return utils;
}

describe('ModelPicker', () => {
  it('exposes a stable data-testid on its trigger — the one seam `SessionChatInput`s modelPicker fork and the composer e2e spec key off of, regardless of harness', () => {
    const vm = buildVm();
    renderPicker(vm);
    expect(screen.getByTestId('model-picker-trigger')).toBeTruthy();
  });

  it('renders one model-first list — no harness fork', async () => {
    const vm = buildVm();
    await openPicker(vm);

    expect(screen.getByText('Anthropic')).toBeTruthy();
    expect(screen.getByText('Claude Sonnet 5', { selector: 'div' })).toBeTruthy();
    expect(screen.getByText('Not connected')).toBeTruthy();
    expect(screen.getByText('GPT-5.1')).toBeTruthy();
  });

  it('shows Experimental badge and live-swap hint as data', async () => {
    const vm = buildVm();
    await openPicker(vm);

    expect(screen.getAllByText('Experimental').length).toBeGreaterThan(0);
    expect(screen.getByTitle('Can switch mid-session')).toBeTruthy();
  });

  it('keeps disconnected providers visible with a Connect CTA', async () => {
    const vm = buildVm();
    const onConnect = mock((_id: HarnessAuthKind) => {});
    await openPicker(vm, onConnect);

    expect(screen.getByText('GPT-5.1')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(onConnect).toHaveBeenCalledWith('codex_subscription');
  });

  it('validates custom entry inline and disables Apply until ok', async () => {
    const vm = buildVm();
    await openPicker(vm);

    const input = screen.getByPlaceholderText('e.g. claude-sonnet-4-6');
    fireEvent.change(input, { target: { value: '' } });

    expect(screen.getByText('Enter a model id')).toBeTruthy();
    const applyButton = screen.getByRole('button', { name: 'Apply' });
    expect(applyButton).toHaveProperty('disabled', true);

    fireEvent.change(input, { target: { value: 'claude-sonnet-4-6' } });
    expect(screen.queryByText('Enter a model id')).toBeNull();
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveProperty('disabled', false);
  });

  it('select() fires with the row key and closes', async () => {
    const vm = buildVm();
    await openPicker(vm);

    const row = screen.getByText('Claude Sonnet 5', { selector: 'div' });
    fireEvent.click(row);
    await flush();

    expect(vm.select).toHaveBeenCalledWith('anthropic:claude-sonnet-5');
    expect(screen.queryByText('Anthropic')).toBeNull();
  });
});

describe('ModelPicker — locked state', () => {
  it('renders the disabled trigger class and skips opening when not interactive', async () => {
    const vm = buildVm({
      trigger: { label: 'Claude Sonnet 5', sublabel: null, interactive: false },
    });
    renderPicker(vm);

    const trigger = screen.getByRole('button', { name: /Claude Sonnet 5/i });
    fireEvent.click(trigger);
    await flush();

    expect(screen.queryByText('Anthropic')).toBeNull();
  });

  it('never renders a Free tag when the item does not explicitly carry free: true', async () => {
    const vm = buildVm();
    await openPicker(vm);

    expect(screen.queryByText('Free')).toBeNull();
  });
});

describe('ModelPicker — within', () => {
  it('scopes row queries per group without leaking across groups', async () => {
    const vm = buildVm();
    await openPicker(vm);

    const notConnectedGroup = screen
      .getByText('Not connected')
      .closest('[cmdk-group]') as HTMLElement;
    expect(within(notConnectedGroup).getByText('GPT-5.1')).toBeTruthy();
  });
});
