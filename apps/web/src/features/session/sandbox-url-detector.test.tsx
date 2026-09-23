import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import { SandboxUrlDetector } from './sandbox-url-detector';

describe('SandboxUrlDetector', () => {
  test('renders a standalone agent link as an action chip', () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
        <SandboxUrlDetector content="[Open files](/projects/p1/files)" isStreaming={false} />
      </NextIntlClientProvider>,
    );

    expect(html).toContain('data-slot="button"');
    expect(html).toContain('href="/projects/p1/files"');
    expect(html).not.toContain('text-kortix-blue');
  });
});
