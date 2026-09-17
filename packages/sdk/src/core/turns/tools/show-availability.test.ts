import { describe, expect, test } from 'bun:test';

import {
  isShowContentUnavailable,
  isShowPayloadEmpty,
  type ShowAvailabilityInput,
} from './show-availability';

const base: ShowAvailabilityInput = {
  running: false,
  isCarousel: false,
  contentStatus: 'ready',
  isWebsitePreview: false,
  previewHasError: false,
  previewIsLinkOnly: false,
};

describe('isShowContentUnavailable', () => {
  test('hides a settled single-item show whose file 404d', () => {
    expect(isShowContentUnavailable({ ...base, contentStatus: 'error' })).toBe(true);
  });

  test('keeps a show whose content loaded', () => {
    expect(isShowContentUnavailable({ ...base, contentStatus: 'ready' })).toBe(false);
  });

  test('keeps a show whose content is still loading', () => {
    expect(isShowContentUnavailable({ ...base, contentStatus: 'loading' })).toBe(false);
  });

  test('never hides while the tool is still running (artifact may be materializing)', () => {
    expect(isShowContentUnavailable({ ...base, running: true, contentStatus: 'error' })).toBe(
      false,
    );
  });

  test('never hides a carousel wholesale', () => {
    expect(isShowContentUnavailable({ ...base, isCarousel: true, contentStatus: 'error' })).toBe(
      false,
    );
  });

  test('hides an errored website/iframe preview', () => {
    expect(
      isShowContentUnavailable({ ...base, isWebsitePreview: true, previewHasError: true }),
    ).toBe(true);
  });

  test('keeps a healthy website preview', () => {
    expect(
      isShowContentUnavailable({ ...base, isWebsitePreview: true, previewHasError: false }),
    ).toBe(false);
  });

  test('keeps an errored preview that is an intentional link-only fallback', () => {
    expect(
      isShowContentUnavailable({
        ...base,
        isWebsitePreview: true,
        previewHasError: true,
        previewIsLinkOnly: true,
      }),
    ).toBe(false);
  });

  test('a website preview ignores contentStatus (iframe health drives it)', () => {
    expect(
      isShowContentUnavailable({
        ...base,
        isWebsitePreview: true,
        previewHasError: false,
        contentStatus: 'error',
      }),
    ).toBe(false);
  });
});

describe('isShowPayloadEmpty', () => {
  test('a show carrying only a type is empty', () => {
    // What the show tool itself rejects with "Error: 'content' is required
    // when type is 'markdown'" — the arguments still reach the renderer.
    expect(isShowPayloadEmpty({ type: 'markdown' })).toBe(true);
  });

  test('title and description are metadata, not an artifact', () => {
    expect(
      isShowPayloadEmpty({ type: 'text', title: 'Q3 report', description: 'the finished thing' }),
    ).toBe(true);
  });

  test('a missing input is empty', () => {
    expect(isShowPayloadEmpty(undefined)).toBe(true);
    expect(isShowPayloadEmpty(null)).toBe(true);
    expect(isShowPayloadEmpty({})).toBe(true);
  });

  test('blank and whitespace-only fields are absence', () => {
    expect(isShowPayloadEmpty({ path: '', url: '', content: '   ' })).toBe(true);
  });

  test('a non-string field is not an artifact', () => {
    expect(isShowPayloadEmpty({ path: 42, url: null, content: false })).toBe(true);
  });

  test('keeps a show with a path', () => {
    expect(isShowPayloadEmpty({ type: 'image', path: '/workspace/logo.png' })).toBe(false);
  });

  test('keeps a show with a url', () => {
    expect(isShowPayloadEmpty({ type: 'url', url: 'http://localhost:3000' })).toBe(false);
  });

  test('keeps a show with inline content', () => {
    expect(isShowPayloadEmpty({ type: 'text', content: 'Build succeeded in 3.2s' })).toBe(false);
  });

  test('keeps an error show — the message IS the content', () => {
    expect(isShowPayloadEmpty({ type: 'error', content: 'pandoc exited 1' })).toBe(false);
  });

  test('keeps a carousel when any one item carries an artifact', () => {
    expect(
      isShowPayloadEmpty({
        items: [{ type: 'image' }, { type: 'image', path: '/workspace/v2.png' }],
      }),
    ).toBe(false);
  });

  test('hides a carousel whose every item is empty', () => {
    expect(isShowPayloadEmpty({ items: [{ type: 'image' }, { type: 'file' }] })).toBe(true);
  });

  test('parses items handed over as a JSON string', () => {
    expect(isShowPayloadEmpty({ items: '[{"type":"file","path":"/tmp/a.csv"}]' })).toBe(false);
    expect(isShowPayloadEmpty({ items: '[{"type":"file"}]' })).toBe(true);
  });

  test('falls back to the single-item fields when items is malformed or empty', () => {
    expect(isShowPayloadEmpty({ items: '[{"path": "/tmp/broken.csv"', content: 'hi' })).toBe(false);
    expect(isShowPayloadEmpty({ items: [], content: 'hi' })).toBe(false);
    expect(isShowPayloadEmpty({ items: '[]' })).toBe(true);
  });

  test('a non-object item never counts as an artifact', () => {
    expect(isShowPayloadEmpty({ items: ['/workspace/a.png', null, 7] })).toBe(true);
  });
});
