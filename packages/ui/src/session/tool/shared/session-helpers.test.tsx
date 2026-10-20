import { describe, expect, test } from 'bun:test';
import { IntlTestProvider } from '../../../test-utils/intl';
import { renderToStaticMarkup } from 'react-dom/server';

import { InlineSessionMessagesList, parseSessionMessagesOutput } from './session-helpers';

const MESSAGES = {
  settings: {
    credits: {
      creditCount: '{count, plural, one {{formatted} credit} other {{formatted} credits}}',
    },
  },
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
      <IntlTestProvider locale="en" messages={MESSAGES} onError={() => {}}>
        <InlineSessionMessagesList messages={parsed ?? []} />
      </IntlTestProvider>,
    );

    // $0.01 is 1 credit; the old 1.2x fudge would read 1.2 credits.
    expect(html).toContain('>1 credit<');
    expect(html).not.toContain('1.2');
    expect(html).not.toContain('$');
  });
});
