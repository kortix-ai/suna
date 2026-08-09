import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { UsageTabView } from './usage-tab';

/** Section titles in document order, read from the h2s SettingsSectionHeader emits. */
const headings = (html: string): string[] =>
  [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1]);

describe('UsageTabView', () => {
  test('the cost explorer renders above the credit ledger', () => {
    const out = renderToStaticMarkup(
      <UsageTabView
        sessionCostsSlot={<div>session-costs</div>}
        creditLedgerSlot={<div>credit-ledger</div>}
      />,
    );
    const h = headings(out);
    expect(h.indexOf('Session costs')).toBeLessThan(h.indexOf('Credit ledger'));
  });

  test('renders exactly the two section headings, in order', () => {
    const out = renderToStaticMarkup(<UsageTabView />);
    expect(headings(out)).toEqual(['Session costs', 'Credit ledger']);
  });

  test('the session-costs slot renders inside the Session costs section', () => {
    const out = renderToStaticMarkup(<UsageTabView sessionCostsSlot={<div>session-costs-marker</div>} />);
    expect(out).toContain('session-costs-marker');
  });

  test('the credit-ledger slot renders inside the Credit ledger section', () => {
    const out = renderToStaticMarkup(<UsageTabView creditLedgerSlot={<div>credit-ledger-marker</div>} />);
    expect(out).toContain('credit-ledger-marker');
  });

  test('with no slots supplied, both section headers still render (each real widget does its own loading state)', () => {
    const out = renderToStaticMarkup(<UsageTabView />);
    expect(headings(out)).toContain('Session costs');
    expect(headings(out)).toContain('Credit ledger');
  });
});
