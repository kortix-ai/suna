import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import { InlineSessionMessagesList, parseSessionMessagesOutput } from './session-helpers';

const MESSAGES = {
  hardcodedUi: {
    componentsSessionToolRenderers: {
      line2350JsxTextTruncated: '(truncated)',
    },
  },
};

describe('InlineSessionMessagesList cost display', () => {
  test('renders the real per-message cost, not a 1.2x fudge', () => {
    const parsed = parseSessionMessagesOutput(
      '--- Msg 1 [assistant] cost=$0.0100 ---\nHello there.',
    );
    expect(parsed).not.toBeNull();

    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={MESSAGES} onError={() => {}}>
        <InlineSessionMessagesList messages={parsed ?? []} />
      </NextIntlClientProvider>,
    );

    expect(html).toContain('$0.0100');
    expect(html).not.toContain('$0.0120');
  });
});
