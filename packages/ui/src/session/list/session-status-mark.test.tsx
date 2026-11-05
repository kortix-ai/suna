import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { GoalStatusMark, goalStatusTone, isReviewOverdue, SessionStatusMark } from './session-status-mark';

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

describe('goalStatusTone', () => {
  test('the agent acting is green, working or ready', () => {
    expect(goalStatusTone('running')).toBe('green');
    expect(goalStatusTone('done')).toBe('green');
  });

  test('waiting on you is blue, and a review that waited over 24h is yellow', () => {
    expect(goalStatusTone('needs-you', 'answer')).toBe('blue');
    expect(goalStatusTone('needs-you', 'review')).toBe('blue');
    expect(goalStatusTone('needs-you', 'review', true)).toBe('yellow');
    expect(goalStatusTone('needs-you', 'answer', true)).toBe('blue');
  });

  test('broken is red', () => {
    expect(goalStatusTone('failed')).toBe('red');
  });

  test('nobody acting leaves the target plain', () => {
    expect(goalStatusTone('stopped')).toBeNull();
    expect(goalStatusTone('starting')).toBeNull();
    expect(goalStatusTone('legacy')).toBeNull();
    expect(goalStatusTone(null)).toBeNull();
  });
});

describe('GoalStatusMark', () => {
  test('a live goal draws one target with a tinted corner and a status dot, no number', () => {
    const html = renderToStaticMarkup(<GoalStatusMark status="failed" />);
    expect(html).toContain('data-goal-tone="red"');
    expect(html).toContain('data-slot="goal-status-dot"');
    expect(html).toContain('var(--kortix-red)');
    expect(html).toContain('mask-image:radial-gradient');
    expect(html).not.toMatch(/>\d+</);
  });

  test('a resting goal draws the plain target alone', () => {
    const html = renderToStaticMarkup(<GoalStatusMark status="stopped" />);
    expect(html).toContain('data-goal-tone="none"');
    expect(html).not.toContain('goal-status-dot');
    expect(html).not.toContain('mask-image');
  });
});
