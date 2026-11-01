import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { isReviewOverdue, SessionStatusMark } from './session-status-mark';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const cr = (status: 'open' | 'merged' | 'closed', updated_at: string) => ({ status, updated_at });

describe('isReviewOverdue', () => {
  test('an open change request untouched for 24h or more is overdue', () => {
    expect(isReviewOverdue([cr('open', '2026-10-20T12:00:00Z')], NOW)).toBe(true);
  });

  test('an open change request under 24h old is not overdue', () => {
    expect(isReviewOverdue([cr('open', '2026-10-20T12:00:01Z')], NOW)).toBe(false);
  });

  test('merged and closed change requests never count, however old', () => {
    expect(
      isReviewOverdue([cr('merged', '2026-01-01T00:00:00Z'), cr('closed', '2026-01-01T00:00:00Z')], NOW),
    ).toBe(false);
  });
});

const render = (status: Parameters<typeof SessionStatusMark>[0]['status']) =>
  renderToStaticMarkup(<SessionStatusMark status={status} />);

const dotCount = (html: string) => (html.match(/data-dot=""/g) ?? []).length;

describe('SessionStatusMark', () => {
  test('done is the dot ring filled with a core, never a check', () => {
    const html = render('done');
    expect(html).toContain('data-glyph="ready"');
    expect(dotCount(html)).toBe(8);
    expect(html).toContain('data-core');
    expect(html).not.toContain('M4 8.4');
  });

  test('running is a half arc with a fading three-dash trail, and does not animate', () => {
    const html = render('running');
    expect(html).toContain('data-glyph="working"');
    expect((html.match(/data-dash=""/g) ?? []).length).toBe(3);
    expect(html).not.toContain('data-core');
    expect(html).not.toContain('animate-');
  });

  test('needs-you is the blue change-request glyph', () => {
    const html = render('needs-you');
    expect(html).toContain('data-glyph="review"');
    expect(html).toContain('var(--kortix-blue)');
  });

  test('needs-you turns yellow once a review is overdue', () => {
    const html = renderToStaticMarkup(<SessionStatusMark status="needs-you" overdue />);
    expect(html).toContain('data-glyph="review"');
    expect(html).toContain('var(--kortix-yellow)');
  });

  test('needs-you waiting on an answer is the blue question glyph, never the change-request glyph', () => {
    const html = renderToStaticMarkup(<SessionStatusMark status="needs-you" waitingOn="answer" overdue />);
    expect(html).toContain('data-glyph="question"');
    expect(html).not.toContain('data-glyph="review"');
    expect(html).toContain('var(--kortix-blue)');
  });

  test('starting draws the same gray ring as stopped', () => {
    expect(render('starting')).toBe(render('stopped'));
  });
});

test('review defaults match explicit review, while answers ignore overdue', () => {
  const draw = (props: Parameters<typeof SessionStatusMark>[0]) => renderToStaticMarkup(<SessionStatusMark {...props} />);
  expect(draw({ status: 'needs-you' })).toBe(draw({ status: 'needs-you', waitingOn: 'review' }));
  expect(draw({ status: 'needs-you', overdue: true })).toBe(draw({ status: 'needs-you', waitingOn: 'review', overdue: true }));
  expect(draw({ status: 'needs-you', waitingOn: 'answer' })).toBe(draw({ status: 'needs-you', waitingOn: 'answer', overdue: true }));
});

test('failed is a red filled ring; legacy stays muted, hidden and static', () => {
  const failed = render('failed');
  expect(failed).toContain('var(--kortix-red)');
  expect(failed).toContain('r="4" fill="currentColor"');
  expect(render('legacy')).toContain('var(--muted-foreground)');
  for (const status of ['done', 'running', 'needs-you', 'starting', 'stopped', 'failed', 'legacy'] as const) {
    expect(render(status)).toContain('aria-hidden="true"');
    expect(render(status)).not.toContain('animate-');
  }
});

test('the supported workspace export renders the canonical glyph', async () => {
  const { SessionStatusMark: WorkspaceMark } = await import('@kortix/ui/workspace');
  expect(WorkspaceMark).toBe(SessionStatusMark);
  expect(renderToStaticMarkup(<WorkspaceMark status="done" />)).toBe(render('done'));
});
