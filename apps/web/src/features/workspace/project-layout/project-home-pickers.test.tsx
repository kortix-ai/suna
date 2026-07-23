// Render suite for the project-home composer pills (BranchPicker /
// SandboxPicker) — pins the 2026-07-21 minimal redesign: CommandPopover
// one-line rows with a check on the selected row, sandbox details in a
// CommandItemHoverCard instead of three-line dropdown rows. Same happy-dom +
// dynamic-import harness as `agent-selector.test.tsx` (Radix needs a real
// DOM). The empty export makes this file a module so top-level `await` is
// legal and the local `screen` can't collide with the DOM global.
export {};

const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
delete (globalThis as any).window;
delete (globalThis as any).document;
GlobalRegistrator.register();

const { afterAll, afterEach, describe, expect, it, mock } = await import('bun:test');
const { act, cleanup, fireEvent, render, screen, within } = await import('@testing-library/react');
const { TooltipProvider } = await import('@/components/ui/tooltip');

mock.module('next-intl', () => ({
  useTranslations: () =>
    Object.assign((key: string) => key, {
      raw: (key: string) => key,
      rich: (key: string) => key,
      markup: (key: string) => key,
    }),
}));

const { BranchPicker, SandboxPicker } = await import('./project-home');

afterEach(() => {
  cleanup();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('BranchPicker — minimal one-line rows', () => {
  const RESPONSE = {
    default_branch: 'main',
    branches: [{ name: 'main' }, { name: 'feature/checkout' }],
  } as any;

  it('rows are one line: mono branch name, a quiet default tag, a check on the active row', async () => {
    render(
      <TooltipProvider>
        <BranchPicker response={RESPONSE} activeRef="main" onSelect={() => {}} />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByTestId('branch-picker'));
    await flush();

    const options = screen.getAllByTestId('branch-option');
    expect(options.map((o) => o.getAttribute('data-branch'))).toEqual(['main', 'feature/checkout']);
    const mainRow = options[0]!;
    expect(within(mainRow).getByText('default')).toBeTruthy();
    // The old explainer copy and per-row icons are gone.
    expect(screen.queryByText('Session branch')).toBeNull();
    expect(screen.queryByText(/Fork this session/)).toBeNull();
  });

  it('selecting a branch reports it and closes the popover', async () => {
    const onSelect = mock((_ref: string) => {});
    render(
      <TooltipProvider>
        <BranchPicker response={RESPONSE} activeRef="main" onSelect={onSelect} />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByTestId('branch-picker'));
    await flush();

    fireEvent.click(
      screen
        .getAllByTestId('branch-option')
        .find((o) => o.getAttribute('data-branch') === 'feature/checkout')!,
    );
    await flush();

    expect(onSelect).toHaveBeenCalledWith('feature/checkout');
    expect(screen.queryAllByTestId('branch-option')).toHaveLength(0);
  });
});

describe('SandboxPicker — one-line rows, details in a hover card', () => {
  const ITEMS = [
    {
      slug: 'default',
      name: 'Default',
      is_default: true,
      has_image: false,
      image: null,
      dockerfile_path: null,
      template_id: 'tpl-1',
      daytona_state: 'active',
    },
    {
      slug: 'gpu',
      name: 'GPU box',
      is_default: false,
      has_image: true,
      image: 'kortix/gpu:latest',
      dockerfile_path: null,
      template_id: 'tpl-2',
      daytona_state: 'missing',
    },
  ] as any[];

  it('rows are one line — state dot + name + check; no inline subtitle or state text', async () => {
    render(
      <TooltipProvider>
        <SandboxPicker items={ITEMS} activeSlug="default" onSelect={() => {}} />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByTestId('sandbox-picker'));
    await flush();

    const options = screen.getAllByTestId('sandbox-option');
    expect(options.map((o) => o.getAttribute('data-sandbox'))).toEqual(['default', 'gpu']);
    // Detail copy is NOT inline anymore.
    expect(screen.queryByText('Platform default · clones workspace at boot')).toBeNull();
    expect(screen.queryByText(/Not built/)).toBeNull();
  });

  it('hovering (focusing) a row surfaces its details in the hover card', async () => {
    render(
      <TooltipProvider>
        <SandboxPicker items={ITEMS} activeSlug="default" onSelect={() => {}} />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByTestId('sandbox-picker'));
    await flush();

    const gpuRow = screen
      .getAllByTestId('sandbox-option')
      .find((o) => o.getAttribute('data-sandbox') === 'gpu')!;
    fireEvent.focus(gpuRow);
    // Radix HoverCard routes even focus opens through openDelay (250ms).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    const card = screen.getByTestId('sandbox-hover-card');
    expect(card.textContent).toContain('GPU box');
    expect(card.textContent).toContain('Image: kortix/gpu:latest');
    expect(card.textContent).toContain('Not built — first session will build it');
  });

  it('selecting a sandbox reports its slug and closes the popover', async () => {
    const onSelect = mock((_slug: string) => {});
    render(
      <TooltipProvider>
        <SandboxPicker items={ITEMS} activeSlug="default" onSelect={onSelect} />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByTestId('sandbox-picker'));
    await flush();

    fireEvent.click(
      screen
        .getAllByTestId('sandbox-option')
        .find((o) => o.getAttribute('data-sandbox') === 'gpu')!,
    );
    await flush();

    expect(onSelect).toHaveBeenCalledWith('gpu');
    expect(screen.queryAllByTestId('sandbox-option')).toHaveLength(0);
  });
});
