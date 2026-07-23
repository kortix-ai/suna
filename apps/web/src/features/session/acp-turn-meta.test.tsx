// Component suite for the turn footer's ⋯ overflow popover. The row-building
// rules live in `acpTurnMetaRows` and are unit-tested in
// `acp-turn-grouping.test.ts`; this file covers the parts that only exist
// once it's mounted — the trigger's presence, and that opening it actually
// renders a labelled list against a live clock.
//
// Real Radix `Popover` needs a real `document.body` to portal into, so this
// uses the `@happy-dom/global-registrator` + dynamic-import dance the other
// interactive suites in this directory use (a static
// `@testing-library/react` import is hoisted above `register()`).
export {};

const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
delete (globalThis as any).window;
delete (globalThis as any).document;
GlobalRegistrator.register();

const { afterAll, afterEach, describe, expect, test } = await import('bun:test');
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react');

const { AcpTurnMeta } = await import('./acp-turn-meta');

afterEach(() => cleanup());
afterAll(() => {
  GlobalRegistrator.unregister();
});

describe('AcpTurnMeta', () => {
  test('renders nothing at all when the harness reported no meta — no ⋯ that opens an empty panel', () => {
    const { container } = render(
      <AcpTurnMeta endedAt={null} durationMs={null} cost={null} usage={null} />,
    );
    expect(container.innerHTML).toBe('');
  });

  test('renders the ⋯ trigger — and nothing else — while closed', () => {
    render(<AcpTurnMeta endedAt={null} durationMs={135_000} cost={null} usage={null} />);
    expect(screen.getByTestId('acp-turn-meta-trigger')).toBeTruthy();
    // The numbers are behind the click, not on the transcript.
    expect(screen.queryByText('Duration')).toBeNull();
    expect(screen.queryByText('2m 15s')).toBeNull();
  });

  test('opening it renders every value against its own label', () => {
    render(
      <AcpTurnMeta
        endedAt={Date.now() - 5_000}
        durationMs={135_000}
        cost={{ amount: 0.45, currency: 'USD' }}
        usage={{ used: 46_000, tokens: null } as any}
      />,
    );
    fireEvent.click(screen.getByTestId('acp-turn-meta-trigger'));

    // Clock is read in the open handler, so the very first rendered frame
    // already carries the right "… ago" rather than correcting itself.
    expect(screen.getByText('Finished')).toBeTruthy();
    expect(screen.getByText('5 seconds ago')).toBeTruthy();
    expect(screen.getByText('Duration')).toBeTruthy();
    expect(screen.getByText('2m 15s')).toBeTruthy();
    expect(screen.getByText('Session cost')).toBeTruthy();
    // No "this session" suffix — "Session cost" already said it.
    expect(screen.getByText('$0.45')).toBeTruthy();
    // "ctx" is gone for good: a spelled-out label and a spelled-out unit.
    expect(screen.getByText('Context')).toBeTruthy();
    expect(screen.getByText('46k tokens')).toBeTruthy();
    expect(screen.queryByText(/ctx/)).toBeNull();
  });

  test('a historical turn (no session totals passed) shows only its own timing', () => {
    render(
      <AcpTurnMeta endedAt={Date.now() - 5_000} durationMs={12_000} cost={null} usage={null} />,
    );
    fireEvent.click(screen.getByTestId('acp-turn-meta-trigger'));

    expect(screen.getByText('12s')).toBeTruthy();
    expect(screen.queryByText('Session cost')).toBeNull();
    expect(screen.queryByText('Context')).toBeNull();
  });

  test('label/value pairs are marked up as a description list, not anonymous divs', () => {
    render(<AcpTurnMeta endedAt={null} durationMs={12_000} cost={null} usage={null} />);
    fireEvent.click(screen.getByTestId('acp-turn-meta-trigger'));

    const label = screen.getByText('Duration');
    const value = screen.getByText('12s');
    expect(label.tagName).toBe('DT');
    expect(value.tagName).toBe('DD');
    // Values are tabular so a column of numbers doesn't twitch between turns.
    expect(value.className).toContain('tabular-nums');
  });

  test('the trigger is a matched pair with the copy button beside it, and names itself for assistive tech', () => {
    render(<AcpTurnMeta endedAt={null} durationMs={12_000} cost={null} usage={null} />);
    const trigger = screen.getByTestId('acp-turn-meta-trigger');
    expect(trigger.getAttribute('aria-label')).toBe('Turn details');
    // Same 28px box + press feedback as `CopyButton`.
    expect(trigger.className).toContain('size-7');
    expect(trigger.className).toContain('active:scale-[0.97]');
  });
});
