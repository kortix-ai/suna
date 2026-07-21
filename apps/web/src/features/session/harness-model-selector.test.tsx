// Render suite for `HarnessModelSelector` — pins the render-cap fix for the
// "Pi picker lags, Codex doesn't" bug: a gateway-backed harness surfaces the
// ENTIRE model catalog as presets (thousands of entries), and mounting one
// `CommandItem` per model froze the popover. Same happy-dom + dynamic-import
// harness as `agent-selector.test.tsx` (Radix `Popover` needs a real DOM).
// The empty export makes this file a module, so `await` is legal at the top
// level and the local `screen` binding can't collide with the DOM global.
export {};

const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
delete (globalThis as any).window;
delete (globalThis as any).document;
GlobalRegistrator.register();

const { afterAll, afterEach, describe, expect, it, mock } = await import('bun:test');
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { TooltipProvider } = await import('@/components/ui/tooltip');
const ReactModule = await import('react');

// The connect-provider gate pulls in the whole connect-modal tree (queries,
// routing) — this suite only cares that the selector renders its list, so
// stub the seam.
mock.module('./use-model-connection-gate', () => ({
  useModelConnectionGate: () => ({ openConnectProvider: () => {}, modal: null }),
}));

const { HarnessModelSelector } = await import('./harness-model-selector');

afterEach(() => {
  cleanup();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

// Radix `Popper` settles its position an effect-tick after `act()` returns —
// flush so no test sees an unwrapped update (same helper the sibling picker
// suites use).
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

function renderSelector(over: Partial<Parameters<typeof HarnessModelSelector>[0]> = {}) {
  render(
    <TooltipProvider>
      <HarnessModelSelector
        harness="pi"
        selectedModel={null}
        onSelect={() => {}}
        presets={MANY_PRESETS}
        connectionKind="managed_gateway"
        {...over}
      />
    </TooltipProvider>,
  );
}

describe('HarnessModelSelector — huge gateway preset lists stay lag-free', () => {
  it('caps the mounted preset rows and says how many more search can reach', async () => {
    renderSelector();
    fireEvent.click(screen.getByTestId('harness-model-selector'));
    await flush();

    expect(screen.getAllByTestId('harness-model-preset').length).toBeLessThanOrEqual(50);
    expect(screen.getByTestId('harness-model-hidden-count').textContent).toContain('450');
  });

  it('search scans the full list, past the cap', async () => {
    renderSelector();
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
    renderSelector({ selectedModel: 'prov/model-499' });
    fireEvent.click(screen.getByTestId('harness-model-selector'));
    await flush();

    const rows = screen.getAllByTestId('harness-model-preset');
    expect(rows.some((row) => row.getAttribute('data-model') === 'prov/model-499')).toBe(true);
  });

  it('a small preset list renders in full with no hidden-count row', async () => {
    renderSelector({ presets: MANY_PRESETS.slice(0, 5) });
    fireEvent.click(screen.getByTestId('harness-model-selector'));
    await flush();

    expect(screen.getAllByTestId('harness-model-preset')).toHaveLength(5);
    expect(screen.queryByTestId('harness-model-hidden-count')).toBeNull();
  });
});

describe('HarnessModelSelector — plain, aligned layout (2026-07-21 simplification)', () => {
  it('search sits ABOVE the list — never below the Automatic row', async () => {
    renderSelector();
    fireEvent.click(screen.getByTestId('harness-model-selector'));
    await flush();

    const searchInput = screen.getByPlaceholderText('Search models…');
    const defaultRow = screen.getByTestId('harness-model-default');
    expect(
      searchInput.compareDocumentPosition(defaultRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('the default row is a one-line "Auto" whose hover card explains who picks the model', async () => {
    renderSelector();
    fireEvent.click(screen.getByTestId('harness-model-selector'));
    await flush();

    const defaultRow = screen.getByTestId('harness-model-default');
    expect(defaultRow.textContent).toBe('Auto');

    // Radix HoverCard opens on keyboard focus too, but always behind its
    // openDelay timer (250ms in CommandItemHoverCard) — wait it out.
    fireEvent.focus(defaultRow);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    const card = screen.getByTestId('harness-model-default-hover-card');
    expect(card.textContent).toContain('Auto');
    expect(card.textContent).toContain('Kortix picks the best model for you.');
  });

  it("the gateway catalog's synthetic Auto preset never renders a second Auto row", async () => {
    renderSelector({
      presets: [
        { id: 'kortix/auto', name: 'Auto', source: 'kortix-gateway' },
        {
          id: 'kortix/anthropic/claude-sonnet-5',
          name: 'Claude Sonnet 5',
          source: 'kortix-gateway',
        },
      ],
    });
    fireEvent.click(screen.getByTestId('harness-model-selector'));
    await flush();

    // Exactly one Auto option in the list: the pinned default row. The
    // synthetic preset must not appear as a second one.
    expect(screen.getAllByTestId('harness-model-default')).toHaveLength(1);
    const rows = screen.getAllByTestId('harness-model-preset');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).not.toContain('Auto');
    // The kortix/ namespace tags rows with the REAL provider, never "kortix".
    expect(rows[0].textContent).toContain('anthropic');
    expect(rows[0].textContent).not.toContain('kortix');
  });

  it('the Automatic row steps aside while searching', async () => {
    renderSelector();
    fireEvent.click(screen.getByTestId('harness-model-selector'));
    await flush();

    fireEvent.change(screen.getByPlaceholderText('Search models…'), {
      target: { value: 'Model 3' },
    });
    await flush();

    expect(screen.queryByTestId('harness-model-default')).toBeNull();
  });

  it('no connection jargon anywhere — rows are one line: name + provider tag, no raw-id subtitle', async () => {
    renderSelector();
    fireEvent.click(screen.getByTestId('harness-model-selector'));
    await flush();

    expect(screen.queryByText('Kortix — included')).toBeNull();
    expect(screen.queryByText('via Kortix (included)')).toBeNull();

    const firstRow = screen.getAllByTestId('harness-model-preset')[0];
    expect(firstRow.textContent).toContain('Model 0');
    expect(firstRow.textContent).toContain('prov');
    expect(firstRow.textContent).not.toContain('prov/model-0');
  });

  it('the custom-ID input hides behind a footer disclosure, and Apply still selects', async () => {
    const onSelect = mock((_model: string | null) => {});
    renderSelector({ onSelect });
    fireEvent.click(screen.getByTestId('harness-model-selector'));
    await flush();

    expect(screen.queryByTestId('harness-model-custom-input')).toBeNull();

    fireEvent.click(screen.getByTestId('harness-model-custom-toggle'));
    await flush();

    const input = screen.getByTestId('harness-model-custom-input');
    fireEvent.change(input, { target: { value: 'my-provider/my-model' } });
    fireEvent.click(screen.getByText('Apply'));
    await flush();

    expect(onSelect).toHaveBeenCalledWith('my-provider/my-model');
  });

  it('subscription connections render no catalog, no search, no Manage — just the default row, the note, and the custom disclosure', async () => {
    renderSelector({
      harness: 'codex',
      connectionKind: 'codex_subscription',
      connectionLabel: 'ChatGPT subscription',
    });
    fireEvent.click(screen.getByTestId('harness-model-selector'));
    await flush();

    expect(screen.queryByTestId('harness-model-preset')).toBeNull();
    expect(screen.queryByPlaceholderText('Search models…')).toBeNull();
    expect(screen.queryByText('Manage')).toBeNull();
    expect(screen.getByTestId('harness-model-default')).toBeTruthy();
    expect(screen.getByTestId('harness-model-subscription-note')).toBeTruthy();
    expect(screen.getByTestId('harness-model-custom-toggle')).toBeTruthy();
  });
});
