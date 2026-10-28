import { describe, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The workspace shell and the header read the session from the SDK; this test
// is about the transcript area between them.
mock.module('./session-workspace', () => ({
  SessionLayout: ({ children }: { children: ReactNode }) => children,
}));
mock.module('../session/header/session-site-header', () => ({
  SessionSiteHeader: () => null,
}));

const { SavedSessionSkeleton } = await import('./saved-session-skeleton');

const SESSION = '2f6c0a52-7d0e-4b8e-9f51-3c5b8d7e0a11';

const render = (status?: ReactNode) =>
  renderToStaticMarkup(
    <SavedSessionSkeleton projectId="p" sessionId={SESSION} stage="starting" status={status} />,
  );

/** A routine wake: `SessionStartingLoader` renders null. */
function Silent() {
  return null;
}

describe('SavedSessionSkeleton', () => {
  test('a status that renders nothing leaves the skeleton rows in place', () => {
    const html = render(<Silent />);
    expect(html).toContain('data-testid="saved-session-skeleton"');
    // The status card hides itself while empty.
    expect(html).toContain('empty:hidden');
  });

  test('a status that speaks shows above the rows, not in place of them', () => {
    const html = render(<p data-testid="wake-note">Still starting your computer.</p>);
    expect(html).toContain('data-testid="saved-session-skeleton"');
    expect(html).toContain('data-testid="wake-note"');
    expect(html.indexOf('saved-session-skeleton')).toBeLessThan(html.indexOf('wake-note'));
  });

  test('without a status there is no status layer', () => {
    const html = render();
    expect(html).toContain('data-testid="saved-session-skeleton"');
    expect(html).not.toContain('empty:hidden');
  });
});
