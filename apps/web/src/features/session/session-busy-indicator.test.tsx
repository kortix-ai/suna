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

  test('elapsed reaches the markup with tabular-nums', () => {
    const markup = renderToStaticMarkup(<SessionBusyIndicator elapsed="1m 5s" />);
    expect(markup).toContain('1m 5s');
    expect(markup).toContain('tabular-nums');
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
});
