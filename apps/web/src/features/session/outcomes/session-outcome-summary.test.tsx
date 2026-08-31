import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Outcome } from './outcome-types';
import { SummaryHeading } from './session-outcome-summary';

const cr: Outcome = {
  id: 'cr:1',
  kind: 'change_request',
  title: 'Change request #1',
  description: '',
  status: { label: 'Waiting for you', tone: 'warning' },
  at: 1,
  meta: [],
  action: { label: 'Review', intent: 'open' },
  resourceHref: null,
};

describe('SummaryHeading', () => {
  test('names what the session produced, in plain language', () => {
    const out = renderToStaticMarkup(
      <SummaryHeading outcomes={[cr, { ...cr, id: 'f:1', kind: 'external' }]} />,
    );
    expect(out).toContain('1 change request, 1 link');
  });

  test('a session that produced nothing renders no heading at all', () => {
    expect(renderToStaticMarkup(<SummaryHeading outcomes={[]} />)).toBe('');
  });
});
