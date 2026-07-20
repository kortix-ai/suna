// Component-render suite for `ReasoningEffortSelector` — the "Thinking" pill
// redesign (Task 21). Follows the `model-picker.test.tsx` precedent: Radix
// `Popover`'s content portals to `document.body`, which silently no-ops
// under this directory's usual `react-test-renderer` harness, so this file
// needs a REAL DOM. `GlobalRegistrator.register()` must run before
// `@testing-library/react` is evaluated (ESM hoists static imports above
// ordinary statements), hence the dynamic `import()`s under a top-level
// `await`.
const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
delete (globalThis as any).window;
delete (globalThis as any).document;
GlobalRegistrator.register();

const { afterAll, afterEach, describe, expect, mock, test } = await import('bun:test');
const { act, cleanup, fireEvent, render, screen, within } = await import('@testing-library/react');
const { TooltipProvider } = await import('@/components/ui/tooltip');

import type { GatewayProjectRoutingPolicy } from '@kortix/sdk/projects-client';

// The write path this component drives — pin it with a spy BEFORE touching
// any presentation. `useGatewayRoutingPolicy` is the only seam
// `useReasoningEffortControl` reads/writes through; every other
// `@kortix/sdk/react` export passes through untouched so unrelated modules
// pulled in transitively (the barrel is evaluated at import time) still work.
const setMutate = mock((_policy: GatewayProjectRoutingPolicy) => {});
let routingData: {
  project: GatewayProjectRoutingPolicy;
  capabilities: { write: boolean };
} | undefined;
let routingIsLoading = false;
let setIsPending = false;

const actualSdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...actualSdkReact,
  useGatewayRoutingPolicy: (_projectId: string | undefined) => ({
    data: routingData,
    isLoading: routingIsLoading,
    set: { mutate: setMutate, isPending: setIsPending },
  }),
}));

const { ReasoningEffortSelector } = await import('./reasoning-effort-selector');

afterEach(() => {
  cleanup();
  setMutate.mockClear();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

// `claude-opus-4.8` is a real managed catalog entry (same fixture
// `reasoning-effort-selector.test.ts` exercises) whose reasoning ladder is
// `['low','medium','high','xhigh','max']`, and whose `displayModel()` name
// ("Claude Opus 4.8") reads nothing like its own wire id
// ("claude-opus-4.8") — exactly what proves the footer/tooltip render the
// friendly name, not the raw wire id.
const MODEL = { providerID: 'kortix', modelID: 'claude-opus-4.8' };
const WIRE_MODEL = 'claude-opus-4.8';
const DISPLAY_NAME = 'Claude Opus 4.8';

function basePolicy(
  over: Partial<GatewayProjectRoutingPolicy['modelGenerationConfig']> = {},
): GatewayProjectRoutingPolicy {
  return {
    modelGenerationConfig: over,
  } as GatewayProjectRoutingPolicy;
}

function setup({
  current = undefined,
  canWrite = true,
  pending = false,
}: {
  current?: string;
  canWrite?: boolean;
  pending?: boolean;
} = {}) {
  routingData = {
    project: basePolicy(current ? { [WIRE_MODEL]: { reasoningEffort: current } } : {}),
    capabilities: { write: canWrite },
  };
  routingIsLoading = false;
  setIsPending = pending;
}

function renderSelector() {
  return render(
    <TooltipProvider>
      <ReasoningEffortSelector model={MODEL} projectId="proj_1" />
    </TooltipProvider>,
  );
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function openSelector() {
  const utils = renderSelector();
  fireEvent.click(screen.getByRole('button', { name: 'Thinking' }));
  await flush();
  return utils;
}

describe('ReasoningEffortSelector — write path (pin before touching presentation)', () => {
  test('selecting a value sends exactly the merged modelGenerationConfig PUT payload — untouched by the redesign', async () => {
    setup({ current: undefined, canWrite: true });
    await openSelector();

    fireEvent.click(screen.getByText('high', { selector: 'span' }));
    await flush();

    expect(setMutate).toHaveBeenCalledTimes(1);
    expect(setMutate).toHaveBeenCalledWith({
      modelGenerationConfig: { [WIRE_MODEL]: { reasoningEffort: 'high' } },
    });
  });

  test('choosing "Auto — model default" clears the override back to null (dropping the model key)', async () => {
    setup({ current: 'high', canWrite: true });
    await openSelector();

    fireEvent.click(screen.getByText('Auto — model default'));
    await flush();

    expect(setMutate).toHaveBeenCalledTimes(1);
    expect(setMutate).toHaveBeenCalledWith({ modelGenerationConfig: {} });
  });
});

describe('ReasoningEffortSelector — trigger', () => {
  test('unset state shows "Auto" in the trigger, not the raw wire value', () => {
    setup({ current: undefined, canWrite: true });
    renderSelector();

    const trigger = screen.getByRole('button', { name: 'Thinking' });
    expect(within(trigger).getByText('Auto')).toBeTruthy();
    expect(within(trigger).queryByText('auto')).toBeNull();
  });

  test('carries the shared composer-pill press-scale class — no hand-rolled drift', () => {
    setup({ current: undefined, canWrite: true });
    renderSelector();

    const trigger = screen.getByRole('button', { name: 'Thinking' });
    const classes = trigger.className.split(' ');
    expect(classes).toContain('active:scale-[0.96]');
    expect(classes).toContain('h-8');
    expect(classes).toContain('rounded-full');
  });

  test('aria-label is "Thinking"', () => {
    setup({ current: undefined, canWrite: true });
    renderSelector();
    expect(screen.getByRole('button', { name: 'Thinking' })).toBeTruthy();
  });
});

describe('ReasoningEffortSelector — popover', () => {
  test('heading reads "Thinking level"', async () => {
    setup({ current: undefined, canWrite: true });
    await openSelector();
    expect(screen.getByText('Thinking level')).toBeTruthy();
  });

  test('first item reads "Auto — model default"', async () => {
    setup({ current: undefined, canWrite: true });
    await openSelector();
    expect(screen.getByText('Auto — model default')).toBeTruthy();
  });

  test('footer shows the friendly display name and NEVER the raw wire id in font-mono', async () => {
    setup({ current: undefined, canWrite: true });
    await openSelector();

    expect(screen.getByText(`Applies to ${DISPLAY_NAME} everywhere in this project.`)).toBeTruthy();
    expect(screen.queryByText(WIRE_MODEL)).toBeNull();
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      expect(el.className?.toString?.().includes('font-mono')).toBe(false);
    }
  });

  test('footer carries the documented classes', async () => {
    setup({ current: undefined, canWrite: true });
    await openSelector();

    const footer = screen.getByText(`Applies to ${DISPLAY_NAME} everywhere in this project.`);
    const classes = footer.className.split(' ');
    expect(classes).toContain('border-t');
    expect(classes).toContain('px-2');
    expect(classes).toContain('py-1.5');
    expect(classes).toContain('text-xs');
    expect(classes).toContain('text-muted-foreground');
  });
});

describe('ReasoningEffortSelector — locked state', () => {
  test('locked trigger is aria-disabled and does not open the popover', async () => {
    setup({ current: undefined, canWrite: false });
    renderSelector();

    const trigger = screen.getByRole('button', { name: 'Thinking' });
    expect(trigger.getAttribute('aria-disabled')).toBe('true');

    fireEvent.click(trigger);
    await flush();
    expect(screen.queryByText('Thinking level')).toBeNull();
  });
});
