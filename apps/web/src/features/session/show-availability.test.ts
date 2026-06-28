import { describe, expect, test } from 'bun:test';

import { isShowContentUnavailable, type ShowAvailabilityInput } from './show-availability';

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
    expect(isShowContentUnavailable({ ...base, running: true, contentStatus: 'error' })).toBe(false);
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
