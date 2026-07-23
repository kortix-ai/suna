// Component suite for the transcript's live status line. The alignment
// contract (a `size-4` leading box + `gap-2`, so the label starts at the
// SAME x as every `AcpTranscriptStep` label above it) is the whole point of
// this row, so it is asserted structurally rather than left to review.
//
// Same `@happy-dom/global-registrator` + dynamic-import dance the other
// component suites in this directory use — a static `@testing-library/react`
// import is hoisted above `GlobalRegistrator.register()` and gets stuck on
// the "no document" stub.
// `export {}` makes this a module: without it TS treats the file as a script,
// which forbids top-level `await` and collides the destructured `screen` with
// the DOM lib's global `screen`. Neighbouring suites get this for free from a
// static `import type`; this one has none.
export {};

const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
delete (globalThis as any).window;
delete (globalThis as any).document;
GlobalRegistrator.register();

const { afterAll, afterEach, describe, expect, test } = await import('bun:test');
const { cleanup, render, screen } = await import('@testing-library/react');

const { AcpBusyIndicator } = await import('./acp-busy-indicator');

afterEach(() => cleanup());
afterAll(() => {
  GlobalRegistrator.unregister();
});

describe('AcpBusyIndicator', () => {
  test('falls back to "Thinking" when no tool is running', () => {
    render(<AcpBusyIndicator />);
    expect(screen.getByText('Thinking')).toBeTruthy();
  });

  test('renders the live tool title when one is running', () => {
    render(<AcpBusyIndicator statusText="Read README.md" />);
    expect(screen.getByText('Read README.md')).toBeTruthy();
    expect(screen.queryByText('Thinking')).toBeNull();
  });

  test('a whitespace-only status falls back rather than rendering a blank line', () => {
    render(<AcpBusyIndicator statusText="   " />);
    expect(screen.getByText('Thinking')).toBeTruthy();
  });

  test('is a polite live region so the status is announced, not silently swapped', () => {
    render(<AcpBusyIndicator statusText="Running tests" />);
    const row = screen.getByTestId('acp-busy-indicator');
    expect(row.getAttribute('role')).toBe('status');
    expect(row.getAttribute('aria-live')).toBe('polite');
  });

  test('leading pulse sits in a size-4 box with gap-2 — the exact gutter StepsTrigger uses, so the label lines up with every step above it', () => {
    render(<AcpBusyIndicator statusText="Read README.md" />);
    const row = screen.getByTestId('acp-busy-indicator');
    expect(row.className).toContain('gap-2');

    const pulseBox = row.firstElementChild!;
    expect(pulseBox.className).toContain('size-4');
    expect(pulseBox.className).toContain('shrink-0');
    // The dot itself is smaller than its box: a 12px dot next to 12px text
    // reads as a blob, and would not centre on the rail's icon line.
    for (const dot of Array.from(pulseBox.children))
      expect(dot.className).toContain('size-2');
  });

  test('a long tool title truncates instead of wrapping and breaking the column', () => {
    render(
      <AcpBusyIndicator statusText="Edit apps/web/src/features/session/acp-session-chat.tsx" />,
    );
    const label = screen.getByText(
      'Edit apps/web/src/features/session/acp-session-chat.tsx',
    );
    expect(label.className).toContain('truncate');
  });

  test('the elapsed timer is tabular, aria-hidden (never announced every second), and starts at 0s', () => {
    render(<AcpBusyIndicator />);
    const timer = screen.getByTestId('acp-busy-indicator').lastElementChild!;
    expect(timer.className).toContain('tabular-nums');
    expect(timer.className).toContain('shrink-0');
    expect(timer.getAttribute('aria-hidden')).toBe('true');
    // `formatAcpDuration` — the same formatter the completed-turn footer
    // uses, so a running turn and a finished one never disagree on shape.
    expect(timer.textContent).toBe('0s');
  });
});
