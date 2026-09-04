import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { parseTodos } from '@/features/session/tool/shared/todo-helpers';
import { PlanPanelCard, planPanelRows } from './plan-card';

/**
 * The Easy panel is the plan's surface on desktop, and `session-chat.tsx`
 * drops every `todowrite` part before segmentation — so if this card stops
 * drawing, a desktop user's plan renders NOWHERE and reads as "the agent never
 * made one". `chatPlanAnchorId` nulls the chat's anchor above 768px, which is
 * the other half of that contract (plan-anchor.test.ts).
 *
 * Seeded through the query cache on the exact key the `todo.updated` SSE
 * handler writes, so these exercise the real data path rather than a prop.
 */
const SESSION = 'ses_panel_plan';

function render(todos: unknown[]) {
  const client = new QueryClient();
  client.setQueryData(['opencode', 'session-todo', SESSION], todos);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <PlanPanelCard sessionId={SESSION} />
    </QueryClientProvider>,
  );
}

const RUNNING = [
  { content: 'Audit the worker registration', status: 'completed' },
  { content: 'Wire the retry budget', status: 'in_progress' },
  { content: 'Backfill the ledger', status: 'pending' },
];

describe('PlanPanelCard header — what the collapsed card says', () => {
  test('names itself, states the fraction, and heads the running step', () => {
    const html = render(RUNNING);

    // The title, so the card is identifiable in a column of four.
    expect(html).toContain('Plan');
    // The fraction, in the slot every sibling card puts its count badge.
    expect(html).toContain('1 of 3');
    // The live step, as the subtitle. This is the whole reason the plan moved
    // off the transcript: it stays on screen while the agent works.
    expect(html).toContain('Wire the retry budget');
  });

  test('the dial carries the same fraction for a screen reader', () => {
    expect(render(RUNNING)).toContain('aria-label="1 of 3 steps done"');
  });

  test('a finished plan says so, calmly, and never "0 of 0"', () => {
    const html = render([
      { content: 'Audit the worker registration', status: 'completed' },
      { content: 'Wire the retry budget', status: 'completed' },
    ]);
    expect(html).toContain('Plan complete');
    expect(html).toContain('2 of 2');
  });

  test('a plan nobody has started has a fraction but no filler subtitle', () => {
    const html = render([
      { content: 'Audit the worker registration', status: 'pending' },
      { content: 'Wire the retry budget', status: 'pending' },
    ]);
    expect(html).toContain('0 of 2');
    // `planSummary.label` is undefined before the plan starts — the dial and
    // the figures already say "not started", and a filler line would only make
    // every header in the column taller.
    expect(html).not.toContain('Plan complete');
  });

  test('the size is stated once — the fraction stands IN the badge’s slot, not beside it', () => {
    const html = render(RUNNING);
    // `PanelCard` renders its count as a `Badge`. Passing both would print
    // "Plan 3  ◐ 1 of 3" — the card's size, twice, in two encodings.
    expect(html).not.toContain('data-slot="badge"');
  });
});

describe('PlanPanelCard draws nothing without a plan', () => {
  test('a session with no todos renders no card at all', () => {
    // Not an empty "promise" row: plenty of sessions never call `todowrite`,
    // and a permanent inert title bar in a four-card column is filler.
    expect(render([])).toBe('');
  });

  test('a malformed todo payload is treated as no plan at all', () => {
    // `parseTodos` is the guard; this pins that the card asks it rather than
    // trusting the cache, since the SSE payload is not schema-checked.
    expect(render([{ nope: true } as unknown])).toBe('');
  });
});

describe('planPanelRows — what the body lists', () => {
  test('the running step is dropped: the subtitle above is already showing it', () => {
    expect(planPanelRows(parseTodos(RUNNING)).map((r) => r.todo.content)).toEqual([
      'Audit the worker registration',
      'Backfill the ledger',
    ]);
  });

  test('a one-step running plan keeps its only row, so the card never opens onto nothing', () => {
    // Without the fallback this filters to [], and the chevron rewards a click
    // with an empty box.
    expect(planPanelRows(parseTodos([{ content: 'Only step', status: 'in_progress' }]))).toHaveLength(
      1,
    );
  });

  test('rows keep the keys they had while the running step was present', () => {
    // Keyed BEFORE filtering, so React's row state stays attached to a step as
    // the agent advances past it rather than shifting with its index.
    const before = planPanelRows(parseTodos([{ content: 'Run the tests', status: 'pending' }]));
    const during = planPanelRows(
      parseTodos([
        { content: 'Run the tests', status: 'pending' },
        { content: 'Ship it', status: 'in_progress' },
      ]),
    );
    expect(before[0].key).toBe(during[0].key);
  });

  test('a repeated line does not collide into one row', () => {
    const rows = planPanelRows(
      parseTodos([
        { content: 'Run the tests', status: 'completed' },
        { content: 'Run the tests', status: 'pending' },
      ]),
    );
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });
});
