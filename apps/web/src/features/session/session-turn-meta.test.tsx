import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { SessionTurnMeta } from './session-turn-meta';

const COST = { cost: 0.45, tokens: { input: 30_000, output: 16_200 } } as const;

describe('SessionTurnMeta', () => {
  test('renders the ⋯ trigger and its aria-label when there is meta to show', () => {
    const html = renderToStaticMarkup(
      <SessionTurnMeta endedAt={Date.now()} durationMs={135_000} cost={COST} />,
    );

    expect(html).toContain('data-testid="session-turn-meta-trigger"');
    expect(html).toContain('aria-label="Turn details"');
  });

  test('renders nothing when the turn carries no meta at all', () => {
    const html = renderToStaticMarkup(
      <SessionTurnMeta endedAt={null} durationMs={null} cost={null} />,
    );

    expect(html).toBe('');
  });

  test('the panel stays out of static markup while closed', () => {
    const html = renderToStaticMarkup(
      <SessionTurnMeta endedAt={Date.now()} durationMs={135_000} cost={COST} />,
    );

    // The panel is portalled and rendered only once Radix opens it, so a
    // closed popover leaves no rows in the initial markup. Row *content* —
    // labels, ordering, formatting — is covered by session-turn-meta-rows.test.ts,
    // not faked here.
    expect(html).not.toContain('Duration');
  });
});
