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

describe('a transport failure is never labelled "Interrupted"', () => {
  // The exact string the sandbox daemon returns when it severs a live turn
  // (`kortix-sandbox-agent-server/src/proxy.ts`). Before this guard, the word
  // "aborted" in the detail matched a bare substring pattern and the user got a
  // muted "Interrupted" with the cause thrown away.
  test('upstream unreachable + "The operation was aborted" shows the error', () => {
    const markup = render({
      errorText: 'upstream unreachable: The operation was aborted.',
    });
    expect(markup).not.toContain('Interrupted');
    expect(markup).toContain('upstream unreachable');
  });

  test('a bare 502 / gateway failure shows the error', () => {
    expect(render({ errorText: 'sandbox upstream unreachable' })).toContain('unreachable');
    expect(render({ errorText: 'fetch failed: socket hang up' })).not.toContain('Interrupted');
  });

  test('a proxy timeout is an error, not an interruption', () => {
    const markup = render({
      errorText: 'Turn is still running and outran this connection’s budget. LONG_TURN_PROXY_TIMEOUT',
    });
    expect(markup).not.toContain('Interrupted');
  });
});

describe('a real user stop is still labelled "Interrupted"', () => {
  test('the caller-supplied identity always wins', () => {
    expect(render({ errorText: 'anything at all', isAbort: true })).toContain('Interrupted');
  });

  test('an explicit abort phrase with no transport words still sniffs', () => {
    expect(render({ errorText: 'The operation was aborted.' })).toContain('Interrupted');
    expect(render({ errorText: 'AbortError' })).toContain('Interrupted');
  });

  test('isAbort=false is respected over the prose', () => {
    const markup = render({ errorText: 'The operation was aborted.', isAbort: false });
    expect(markup).not.toContain('Interrupted');
  });
});
