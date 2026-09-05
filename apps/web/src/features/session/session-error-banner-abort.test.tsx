import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import { TurnErrorDisplay } from './session-error-banner';

const render = (props: Parameters<typeof TurnErrorDisplay>[0]) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
      <TurnErrorDisplay {...props} />
    </NextIntlClientProvider>,
  );

describe('a transport failure is never swallowed as an interruption', () => {
  // The exact string the sandbox daemon returns when it severs a live turn
  // (`kortix-sandbox-agent-server/src/proxy.ts`). Before this guard, the word
  // "aborted" in the detail matched a bare substring pattern and the user got a
  // muted "Interrupted" with the cause thrown away. Now an abort renders
  // nothing at all, so a misclassification would hide the failure entirely —
  // the guard matters more, not less.
  test('upstream unreachable + "The operation was aborted" shows the error', () => {
    const markup = render({
      errorText: 'upstream unreachable: The operation was aborted.',
    });
    expect(markup).toContain('upstream unreachable');
  });

  test('a bare 502 / gateway failure shows the error', () => {
    expect(render({ errorText: 'sandbox upstream unreachable' })).toContain('unreachable');
    expect(render({ errorText: 'fetch failed: socket hang up' })).toContain('socket hang up');
  });

  test('a proxy timeout is an error, not an interruption', () => {
    const markup = render({
      errorText:
        'Turn is still running and outran this connection’s budget. LONG_TURN_PROXY_TIMEOUT',
    });
    expect(markup).toContain('LONG_TURN_PROXY_TIMEOUT');
  });
});

// A stop is something the user asked for — pressing Stop here, pressing it in
// another tab (which reaches this renderer as an untagged wire
// `MessageAbortedError`), or a runtime disposing under them. Reporting it back
// as an error row is noise, so every abort renders nothing.
describe('an interrupted turn renders nothing at all', () => {
  test('the caller-supplied identity always wins', () => {
    expect(render({ errorText: 'anything at all', isAbort: true }).trim()).toBe('');
  });

  test('an explicit abort phrase with no transport words still sniffs', () => {
    expect(render({ errorText: 'The operation was aborted.' }).trim()).toBe('');
    expect(render({ errorText: 'AbortError' }).trim()).toBe('');
  });

  test('isAbort=false is respected over the prose', () => {
    const markup = render({ errorText: 'The operation was aborted.', isAbort: false });
    expect(markup).toContain('The operation was aborted.');
  });

  // T2: two DIFFERENT client-synthesized producers both patch
  // `{ name: 'AbortError' }` onto a message — `applyOptimisticAbort` (a real
  // user Stop, `data.reason: 'user'`) and `markSessionAbortedLocally` (pure
  // infrastructure — a runtime disposed and respawned mid-stream,
  // `data.reason: 'runtime-disposed'`). Both are silent, so the banner no
  // longer needs to tell them apart.
  test('an infra respawn renders nothing — no row, no empty card', () => {
    const markup = render({
      errorText: 'The operation was aborted because the runtime shut down.',
      isAbort: true,
    });
    expect(markup.trim()).toBe('');
  });

  test('a non-abort error still renders its card', () => {
    const markup = render({
      errorText: 'insufficient credits: Balance: $-1.00',
      isAbort: false,
    });
    expect(markup.length).toBeGreaterThan(0);
  });
});
