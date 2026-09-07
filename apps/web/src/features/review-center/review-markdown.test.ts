import type { ApiReviewItem } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import { looksLikeMarkdown } from '@/lib/markdown-detect';
import { mapApiReviewItem } from './map';
import type { ChangeDetail } from './types';

describe('looksLikeMarkdown', () => {
  test('detects the clear markdown signals', () => {
    expect(looksLikeMarkdown('## What this changes\nMigrates the manifest.')).toBe(true);
    expect(looksLikeMarkdown('This has **bold emphasis** in it.')).toBe(true);
    expect(looksLikeMarkdown('Run `kortix validate` before landing.')).toBe(true);
    expect(looksLikeMarkdown('```yaml\nagents: {}\n```')).toBe(true);
    expect(looksLikeMarkdown('See [the docs](https://kortix.com/docs).')).toBe(true);
    expect(looksLikeMarkdown('1. fetch\n2. rebase\n3. push')).toBe(true);
  });

  test('plain prose stays plain — the designed checkmark treatment must survive', () => {
    expect(looksLikeMarkdown('Fixed the header alignment on mobile.')).toBe(false);
    expect(looksLikeMarkdown('Updated dependencies.\nFixed two flaky tests.')).toBe(false);
    // Simple dash bullets are common in plain agent output — not enough signal
    // on their own to switch away from the per-line checkmarks.
    expect(looksLikeMarkdown('- updated the schema\n- fixed the tests')).toBe(false);
  });

  test('is not fooled by lookalikes', () => {
    expect(looksLikeMarkdown('The #4135 PR shipped yesterday.')).toBe(false); // not an ATX heading
    expect(looksLikeMarkdown('rated 5* by users')).toBe(false);
    expect(looksLikeMarkdown('')).toBe(false);
  });
});

describe('mapApiReviewItem — change descriptions are plain lines', () => {
  const changeRow = (description: string): ApiReviewItem =>
    ({
      review_item_id: 'rv-1',
      kind: 'change',
      title: 'Migrate manifest to v2',
      summary: 'CR #12',
      status: 'pending',
      risk: 'medium',
      agent: 'Agent',
      created_at: '2026-07-08T10:00:00.000Z',
      detail: { cr_id: 'cr-12', base_ref: 'main', head_ref: 'session/x', description },
    }) as unknown as ApiReviewItem;

  test('a markdown-looking description is still line-split — no markdown branch', () => {
    const md = '## What this changes\nMigrates `kortix.toml` to **kortix.yaml**.';
    const d = mapApiReviewItem(changeRow(md), 'proj').detail as ChangeDetail;
    expect(d.whatChanged).toEqual([
      '## What this changes',
      'Migrates `kortix.toml` to **kortix.yaml**.',
    ]);
    expect('descriptionMarkdown' in d).toBe(false);
  });

  test('a plain description keeps the per-line treatment', () => {
    const d = mapApiReviewItem(changeRow('Updated the schema.\nFixed the tests.'), 'proj')
      .detail as ChangeDetail;
    expect(d.whatChanged).toEqual(['Updated the schema.', 'Fixed the tests.']);
  });

  test('a native structured whatChanged array always wins over the description', () => {
    const row = changeRow('## ignored');
    (row.detail as Record<string, unknown>).whatChanged = ['Did the thing'];
    const d = mapApiReviewItem(row, 'proj').detail as ChangeDetail;
    expect(d.whatChanged).toEqual(['Did the thing']);
  });
});
