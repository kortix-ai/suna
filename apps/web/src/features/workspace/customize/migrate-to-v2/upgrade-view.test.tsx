import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { UpgradeViewContent } from './upgrade-view';

describe('UpgradeViewContent — per-state rendering', () => {
  test('v1 renders the migration explainer and the passed-in action', () => {
    const html = renderToStaticMarkup(
      <UpgradeViewContent version={1} action={<button type="button">Migrate to v2</button>} />,
    );
    expect(html).toContain('Upgrade to v2');
    expect(html).toContain('What happens');
    expect(html).toContain('An agent session does the conversion');
    expect(html).toContain('Migrate to v2');
  });

  test('v2 (stale deep-link) renders the already-migrated empty state, no action', () => {
    const html = renderToStaticMarkup(
      <UpgradeViewContent version={2} action={<button type="button">Migrate to v2</button>} />,
    );
    expect(html).toContain('Already on v2');
    expect(html).not.toContain('Migrate to v2');
    expect(html).not.toContain('What happens');
  });

  test('unresolved manifest read renders placeholders only — no CTA, no premature claim', () => {
    const html = renderToStaticMarkup(
      <UpgradeViewContent version={null} action={<button type="button">Migrate to v2</button>} />,
    );
    expect(html).not.toContain('Migrate to v2');
    expect(html).not.toContain('Already on v2');
    expect(html).not.toContain('What happens');
  });
});
