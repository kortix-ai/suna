import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import messages from '../../../../translations/en.json';
import { ServedModelBadge } from './served-model-badge';

function render(notice: { served: string; fallbackFrom: string }): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ServedModelBadge notice={notice} />
    </NextIntlClientProvider>,
  );
}

describe('ServedModelBadge', () => {
  // Incident 2026-10-02: the selector named the ChatGPT model while a Kortix
  // model answered. The badge names the model that ran, in words.
  test('names the model that answered beside the selector', () => {
    const html = render({ served: 'GLM 5.3 Flash', fallbackFrom: 'GPT-6.1 Sol (ChatGPT)' });
    expect(html).toContain('data-testid="served-model-badge"');
    expect(html).toContain('Running on GLM 5.3 Flash');
    // The reason sits in a tooltip: a keyboard reaches it only through focus.
    expect(html).toContain('tabindex="0"');
    // The mark is not color alone: the words carry it, the dot repeats it.
    expect(html).toContain('data-slot="status-dot"');
    // A note beside the selector, not a chip: no uppercase mono badge.
    expect(html).not.toContain('uppercase');
  });
});
