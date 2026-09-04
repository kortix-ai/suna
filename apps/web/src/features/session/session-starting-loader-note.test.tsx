import {
  SessionConnectingBanner,
  SessionStartingLoader,
} from '@/features/session/session-starting-loader';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

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

  test('the loader shows the ladder note instead of the phase label', () => {
    const html = render(<SessionStartingLoader stage="starting" delayMs={0} note={NOTE} />);
    expect(html).toContain(NOTE);
  });

  test('the legacy variant input renders the same ladder note', () => {
    const html = render(
      <SessionStartingLoader stage="starting" delayMs={0} variant="stepper" note={NOTE} />,
    );
    expect(html).toContain(NOTE);
    expect(html).not.toContain('This usually takes a few seconds.');
  });
});

describe('session starting loader treatment', () => {
  test('renders quiet progress without prototype or legacy motion', () => {
    const html = render(<SessionStartingLoader stage="starting" delayMs={0} variant="stepper" />);

    expect(html).toContain('Starting your session');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuetext="Step 2 of 4: Loading your workspace"');
    expect(html).not.toContain('data-uidotsh-pick');
    expect(html).not.toContain('animate-pulse');
    expect(html).not.toContain('This usually takes a few seconds.');
  });
});
