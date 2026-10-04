import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { AuthPopupShell } from './auth-popup-shell';

function render(status: 'loading' | 'processing' | 'error', errorActions?: React.ReactNode) {
  return renderToStaticMarkup(
    <AuthPopupShell
      title="Connect GitHub"
      status={status}
      errorMessage=""
      errorText="Something went wrong"
      processingText="Finishing up"
      waitingText="Waiting for GitHub"
      errorActions={errorActions}
    />,
  );
}

describe('AuthPopupShell', () => {
  test('the waiting state names what the popup is waiting for', () => {
    const html = render('loading');
    expect(html).toContain('Connect GitHub');
    expect(html).toContain('Waiting for GitHub');
    expect(html).not.toContain('Finishing up');
    expect(html).not.toContain('Something went wrong');
  });

  test('the processing state swaps the line, keeps the frame', () => {
    const html = render('processing');
    expect(html).toContain('Finishing up');
    expect(html).not.toContain('Waiting for GitHub');
  });

  test('the error state shows the strip, with the fallback when the message is empty', () => {
    const html = render('error');
    expect(html).toContain('Something went wrong');
    expect(html).not.toContain('Waiting for GitHub');
    expect(html).not.toContain('<button');
  });

  test('error actions render under the strip, and only in the error state', () => {
    const withActions = render('error', <button type="button">Close</button>);
    expect(withActions).toContain('Close');
    expect(render('loading', <button type="button">Close</button>)).not.toContain('Close');
  });
});
