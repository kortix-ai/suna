import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import messages from '../../../../translations/en.json';
import { ServedModelBar } from './served-model-bar';

function render(notice: { served: string; fallbackFrom: string }): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ServedModelBar notice={notice} />
    </NextIntlClientProvider>,
  );
}

describe('ServedModelBar', () => {
  // Incident 2026-10-02: the selector named the ChatGPT model while a Kortix
  // model answered. The strip names the model that ran and the one that did not.
  test('names the model that answered and the model it replaced', () => {
    const html = render({ served: 'GLM 5.3 Flash', fallbackFrom: 'GPT-6.1 Sol (ChatGPT)' });
    expect(html).toContain('data-testid="served-model-bar"');
    expect(html).toContain('Running on GLM 5.3 Flash');
    expect(html).toContain('GPT-6.1 Sol (ChatGPT) did not answer the last request');
    // Not color alone: a glyph and the words carry it.
    expect(html).toContain('<svg');
    // It appears on its own: a screen reader must announce it.
    expect(html).toContain('role="status"');
  });
});
