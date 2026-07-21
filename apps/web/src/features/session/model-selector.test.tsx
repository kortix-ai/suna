// Render suite for the merged `ModelSelector` — the ONE model picker (no
// flag, no alternate component). Covers harness mode (Claude/Codex/Pi,
// ported from the former harness-model-selector.tsx) and the removal of the
// free-typed "enter a model id" affordance the owner explicitly rejected.
// Same happy-dom + dynamic-import harness as `agent-selector.test.tsx` (Radix
// `Popover` needs a real DOM). The empty export makes this file a module, so
// `await` is legal at the top level and the local `screen` binding can't
// collide with the DOM global.
export {};

const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
delete (globalThis as any).window;
delete (globalThis as any).document;
GlobalRegistrator.register();

const { afterAll, afterEach, describe, expect, it, mock } = await import('bun:test');
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { TooltipProvider } = await import('@/components/ui/tooltip');

// The connect-provider gate pulls in the whole connect-modal tree (queries,
// routing) — this suite only cares that the selector renders its list, so
// stub the seam.
mock.module('./use-model-connection-gate', () => ({
  useModelConnectionGate: () => ({ openConnectProvider: () => {}, modal: null }),
}));

const { ModelSelector } = await import('./model-selector');

afterEach(() => {
  cleanup();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

// Radix `Popper` settles its position an effect-tick after `act()` returns —
// flush so no test sees an unwrapped update.
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const MANY_PRESETS = Array.from({ length: 500 }, (_, i) => ({
  id: `prov/model-${i}`,
  name: `Model ${i}`,
  source: 'models.dev',
}));

function renderHarness(over: Partial<Parameters<typeof ModelSelector>[0]['harnessModel']> = {}) {
  render(
    <TooltipProvider>
      <ModelSelector
        harnessModel={{
          harness: 'pi',
          selectedModel: null,
          onSelect: () => {},
          presets: MANY_PRESETS,
          connectionKind: 'managed_gateway',
          ...over,
        }}
      />
    </TooltipProvider>,
  );
}

describe('ModelSelector (harness mode) — huge gateway preset lists stay lag-free', () => {
  it('caps the mounted preset rows and says how many more search can reach', async () => {
    renderHarness();
    fireEvent.click(screen.getByTestId('harness-model-selector'));
    await flush();

    expect(screen.getAllByTestId('harness-model-preset').length).toBeLessThanOrEqual(50);
    expect(screen.getByTestId('harness-model-hidden-count').textContent).toContain('450');
  });

  it('search scans the full list, past the cap', async () => {
    renderHarness();
    fireEvent.click(screen.getByTestId('harness-model-selector'));
    await flush();

    fireEvent.change(screen.getByPlaceholderText('Search models…'), {
      target: { value: 'Model 499' },
    });
    await flush();

    const rows = screen.getAllByTestId('harness-model-preset');
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute('data-model')).toBe('prov/model-499');
  });

  it('a selected model beyond the cap is still rendered (its check never disappears)', async () => {
    renderHarness({ selectedModel: 'prov/model-499' });
    fireEvent.click(screen.getByTestId('harness-model-selector'));
    await flush();

    const rows = screen.getAllByTestId('harness-model-preset');
    expect(rows.some((row) => row.getAttribute('data-model') === 'prov/model-499')).toBe(true);
  });

  it('a small preset list renders in full with no hidden-count row', async () => {
    renderHarness({ presets: MANY_PRESETS.slice(0, 5) });
    fireEvent.click(screen.getByTestId('harness-model-selector'));
    await flush();

    expect(screen.getAllByTestId('harness-model-preset')).toHaveLength(5);
    expect(screen.queryByTestId('harness-model-hidden-count')).toBeNull();
  });
});

describe('ModelSelector (harness mode) — plain, aligned layout', () => {
  it('the default row is a one-line "Auto" whose hover card explains who picks the model', async () => {
    renderHarness();
    fireEvent.click(screen.getByTestId('harness-model-selector'));
    await flush();

    const defaultRow = screen.getByTestId('harness-model-default');
    expect(defaultRow.textContent).toBe('Auto');

    fireEvent.focus(defaultRow);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    const card = screen.getByTestId('harness-model-default-hover-card');
    expect(card.textContent).toContain('Auto');
    expect(card.textContent).toContain('Kortix picks the best model for you.');
  });

  it('subscription connections render no catalog, no search, no Manage, and NO custom-id entry — just the default row + note', async () => {
    renderHarness({
      harness: 'codex',
      connectionKind: 'codex_subscription',
      connectionLabel: 'ChatGPT subscription',
    });
    fireEvent.click(screen.getByTestId('harness-model-selector'));
    await flush();

    expect(screen.queryByTestId('harness-model-preset')).toBeNull();
    expect(screen.queryByPlaceholderText('Search models…')).toBeNull();
    expect(screen.queryByText('Manage')).toBeNull();
    expect(screen.queryByText('Manage models')).toBeNull();
    expect(screen.getByTestId('harness-model-default')).toBeTruthy();
    expect(screen.getByTestId('harness-model-subscription-note')).toBeTruthy();
  });

  it('never renders a free-typed "enter a model id" / custom model id affordance, in any state', async () => {
    renderHarness();
    fireEvent.click(screen.getByTestId('harness-model-selector'));
    await flush();

    expect(screen.queryByText(/custom model id/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/e\.g\. claude-sonnet/i)).toBeNull();
    expect(screen.queryByLabelText(/custom model id/i)).toBeNull();
  });
});
