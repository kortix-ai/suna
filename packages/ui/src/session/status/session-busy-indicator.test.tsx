import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { SessionBusyIndicator } from './session-busy-indicator';

describe('SessionBusyIndicator', () => {
  test('falls back to Thinking with no props', () => {
    const markup = renderToStaticMarkup(<SessionBusyIndicator />);
    expect(markup).toContain('Thinking');
  });

  test('starts the default Thinking shimmer at its sweep origin', () => {
    const markup = renderToStaticMarkup(<SessionBusyIndicator />);
    expect(markup).toContain('background-position:100% center');
  });

  test('renders the supplied status text', () => {
    const markup = renderToStaticMarkup(<SessionBusyIndicator statusText="Running tests" />);
    expect(markup).toContain('Running tests');
    expect(markup).not.toContain('Thinking');
  });

  test('falls back to Thinking for whitespace-only status text', () => {
    const markup = renderToStaticMarkup(<SessionBusyIndicator statusText="   " />);
    expect(markup).toContain('Thinking');
  });

  test('retryLabel wins over statusText and suppresses the shimmer', () => {
    const markup = renderToStaticMarkup(
      <SessionBusyIndicator statusText="Running tests" retryLabel="Waiting to retry" />,
    );
    expect(markup).toContain('Waiting to retry');
    expect(markup).not.toContain('Running tests');
    expect(markup).not.toContain('bg-clip-text');
  });

  test('omitting elapsed renders no trailing element', () => {
    const markup = renderToStaticMarkup(<SessionBusyIndicator />);
    expect(markup).not.toContain('tabular-nums');
  });

  test('ambient without status cycles a filler line, not Thinking', () => {
    const markup = renderToStaticMarkup(<SessionBusyIndicator ambient />);
    expect(markup).not.toContain('>Thinking<');
    expect(markup).toContain('bg-clip-text');
  });

  test('statusText wins over ambient', () => {
    const markup = renderToStaticMarkup(
      <SessionBusyIndicator ambient statusText="Running tests" />,
    );
    expect(markup).toContain('Running tests');
  });

  // Regression: the elapsed counter used to be concatenated into `statusText`,
  // so the animated span's key changed once a second and replayed the roll-swap
  // for the whole of any long tool call. The phrase markup either side of the
  // elapsed span must stay byte-identical as the clock ticks.
  test('elapsed time ticks without changing the animated phrase', () => {
    const at21 = renderToStaticMarkup(
      <SessionBusyIndicator statusText="Running tests" elapsedLabel="21s" />,
    );
    const at22 = renderToStaticMarkup(
      <SessionBusyIndicator statusText="Running tests" elapsedLabel="22s" />,
    );
    expect(at21).toContain('21s');
    expect(at22).toContain('22s');
    expect(at21).toContain('tabular-nums');
    expect(at21.replace('21s', 'X')).toBe(at22.replace('22s', 'X'));
  });

  test('omitting elapsedLabel renders no separator', () => {
    const markup = renderToStaticMarkup(<SessionBusyIndicator statusText="Thinking" />);
    expect(markup).not.toContain('&middot;');
  });

  // The ambient phrases rotate on a 4s timer and carry no information, so the
  // live region is muted for them; a real status still announces.
  test('ambient mutes the live region, real status announces', () => {
    expect(renderToStaticMarkup(<SessionBusyIndicator ambient />)).toContain('aria-live="off"');
    expect(renderToStaticMarkup(<SessionBusyIndicator statusText="Running tests" />)).toContain(
      'aria-live="polite"',
    );
  });
});
