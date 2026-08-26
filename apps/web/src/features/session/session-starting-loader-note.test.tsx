import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { SessionConnectingBanner, SessionStartingLoader } from '@/features/session/session-starting-loader';

const NOTE = 'Still waking — restarting the runtime (attempt 3)';

function render(node: React.ReactNode) {
  const client = new QueryClient();
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

describe('escalation note reaches the pixels', () => {
  test('the connecting banner shows the ladder note instead of the phase label', () => {
    const html = render(<SessionConnectingBanner stage="starting" note={NOTE} />);
    expect(html).toContain(NOTE);
    expect(html).not.toContain('Waking the agent');
  });

  test('without a note the banner keeps the ordinary phase label', () => {
    const html = render(<SessionConnectingBanner stage="starting" />);
    expect(html).toContain('Loading your workspace');
    expect(html).not.toContain('Still waking');
  });

  test('the compact loader headline becomes the note', () => {
    const html = render(<SessionStartingLoader stage="starting" delayMs={0} note={NOTE} />);
    expect(html).toContain(NOTE);
  });

  test('the stepper hint carries the note instead of the generic reassurance', () => {
    const html = render(
      <SessionStartingLoader stage="starting" delayMs={0} variant="stepper" note={NOTE} />,
    );
    expect(html).toContain(NOTE);
    expect(html).not.toContain('This usually takes a few seconds.');
  });
});
