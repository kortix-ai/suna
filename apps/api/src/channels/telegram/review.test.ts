import { describe, expect, test } from 'bun:test';
import type { ReviewCardItem } from '../slack/review-cards';
import {
  buildReviewKeyboard,
  decodeReviewCallback,
  encodeReviewCallback,
  isReviewCallback,
  renderReviewHtml,
} from './review';

const ID = 'a1b2c3d4-e5f6-4788-9abc-def012345678';
const item = (over: Partial<ReviewCardItem> = {}): ReviewCardItem => ({
  review_item_id: ID,
  kind: 'approval',
  risk: 'medium',
  title: 'Deploy to prod',
  summary: 'Ship build 1234 to production.',
  ...over,
});

describe('review callback encode/decode', () => {
  test('round-trips verb + item id, fits Telegram 64-byte cap', () => {
    expect(encodeReviewCallback('approve', ID)).toBe(`kxr:approve:${ID}`);
    expect(Buffer.byteLength(encodeReviewCallback('changes', ID))).toBeLessThanOrEqual(64);
    expect(decodeReviewCallback(`kxr:approve:${ID}`)).toEqual({ verb: 'approve', id: ID });
    expect(decodeReviewCallback(`kxr:deny:${ID}`)).toEqual({ verb: 'deny', id: ID });
    expect(decodeReviewCallback(`kxr:changes:${ID}`)).toEqual({ verb: 'changes', id: ID });
  });

  test('rejects unknown verbs and foreign callbacks', () => {
    expect(decodeReviewCallback(undefined)).toBeNull();
    expect(decodeReviewCallback('kxr:view:x')).toBeNull(); // view is a URL button, no callback
    expect(decodeReviewCallback('kxr:bogus:x')).toBeNull();
    expect(decodeReviewCallback('kxq:0:1')).toBeNull();
    expect(isReviewCallback(`kxr:approve:${ID}`)).toBe(true);
    expect(isReviewCallback('kxa:x')).toBe(false);
  });
});

describe('buildReviewKeyboard', () => {
  test('Approve/Reject on row 1, changes on row 2, View url when present', () => {
    const kb = buildReviewKeyboard(item(), 'https://k.x/s/1');
    expect(kb[0][0].callbackData).toBe(`kxr:approve:${ID}`);
    expect(kb[0][1].callbackData).toBe(`kxr:deny:${ID}`);
    expect(kb[1][0].callbackData).toBe(`kxr:changes:${ID}`);
    expect(kb[2][0]).toEqual({ text: 'View in Kortix', url: 'https://k.x/s/1' });
  });

  test('omits the View row when there is no web url', () => {
    const kb = buildReviewKeyboard(item(), null);
    expect(kb).toHaveLength(2);
    expect(kb.some((row) => row.some((b) => b.url))).toBe(false);
  });

  test('primary label follows the item kind', () => {
    expect(buildReviewKeyboard(item({ kind: 'change' }), null)[0][0].text).toContain('Ship it');
    expect(buildReviewKeyboard(item({ kind: 'decision' }), null)[0][0].text).toContain('Answer');
    expect(buildReviewKeyboard(item({ kind: 'approval' }), null)[0][0].text).toContain('Approve');
  });
});

describe('renderReviewHtml', () => {
  test('shows title, summary, and a risk line', () => {
    const html = renderReviewHtml(item({ risk: 'high' }));
    expect(html).toContain('Deploy to prod');
    expect(html).toContain('Ship build 1234');
    expect(html).toContain('high risk');
    expect(html).toContain('🔴');
  });

  test('no risk line when risk is none', () => {
    expect(renderReviewHtml(item({ risk: 'none' }))).not.toContain('risk');
  });

  test('escapes HTML in title/summary', () => {
    const html = renderReviewHtml(item({ title: '<b>x</b>', summary: 'a & b' }));
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain('a &amp; b');
  });
});
