import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionReloadProgressView } from './session-reload-progress-view';

describe('SessionReloadProgressView', () => {
  test('renders current, completed, and pending steps', () => {
    const html = renderToStaticMarkup(<SessionReloadProgressView phase="applying-config" />);

    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('data-state="current"');
    expect(html).toContain('Applying config and validating runtime');
    expect(html).toContain('data-state="complete"');
    expect(html).toContain('Checking session');
    expect(html).toContain('Refreshing workspace');
    expect(html).toContain('data-state="pending"');
    expect(html).toContain('Confirming active config');
  });

  test('renders the workspace refresh like any other step, without a skipped state', () => {
    const html = renderToStaticMarkup(<SessionReloadProgressView phase="refreshing-workspace" />);

    expect(html).toContain('data-state="current"');
    expect(html).toContain('Refreshing workspace');
    expect(html).not.toContain('Skipped');
  });
});
