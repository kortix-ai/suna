import { describe, expect, test } from 'bun:test';

import {
  imageGenTitle,
  imageSearchBadge,
  imageSearchTiles,
  parseImageOutput,
  parseImageSearchOutput,
  parseVideoOutput,
  presentationActionLabel,
  presentationHasOwnSuccessLine,
  presentationTriggerSubtitle,
} from './web-media';

describe('image search output', () => {
  test('batch mode flattens every query and names the query count', () => {
    const out = JSON.stringify({
      batch_mode: true,
      results: [
        { query: 'cats', images: [{ url: 'https://i/1.png' }] },
        { query: 'dogs', images: [{ url: 'https://i/2.png' }, { url: 'https://i/3.png' }] },
      ],
    });
    const parsed = parseImageSearchOutput(out, 'input');
    expect(parsed.isBatch).toBe(true);
    expect(parsed.batchCount).toBe(2);
    expect(parsed.displayQuery).toBe('2 queries');
    expect(parsed.imageResults).toHaveLength(3);
    expect(imageSearchBadge(parsed)).toBe('2q, 3 images');
  });

  test('plain arrays, { images }, { results } and garbage', () => {
    expect(parseImageSearchOutput(JSON.stringify([{ url: 'https://a/1.png' }]), 'q').imageResults).toHaveLength(1);
    expect(parseImageSearchOutput(JSON.stringify({ images: [{}, {}] }), 'q').imageResults).toHaveLength(2);
    expect(parseImageSearchOutput(JSON.stringify({ results: [{}] }), 'q').imageResults).toHaveLength(1);
    const junk = parseImageSearchOutput('not json', 'q');
    expect(junk.imageResults).toHaveLength(0);
    expect(junk.displayQuery).toBe('q');
    expect(imageSearchBadge(junk)).toBeUndefined();
  });

  test('tiles keep at most 9 safe http(s) images, reading every url field name', () => {
    const images = [
      { url: 'https://a/1.png', title: 'one' },
      { imageUrl: 'https://a/2.png' },
      { image_url: 'https://a/3.png' },
      { url: 'javascript:alert(1)' },
      ...Array.from({ length: 10 }, (_, i) => ({ url: `https://b/${i}.png` })),
    ];
    const tiles = imageSearchTiles(images);
    expect(tiles).toHaveLength(8);
    expect(tiles[0]).toEqual({ url: 'https://a/1.png', title: 'one' });
    expect(tiles.some((t) => t.url.startsWith('javascript'))).toBe(false);
  });
});

describe('image gen output (web image-output-path)', () => {
  test('JSON path and url fields', () => {
    expect(parseImageOutput(JSON.stringify({ path: '/workspace/a.png', url: 'https://r/a.png' }))).toEqual({
      imagePath: '/workspace/a.png',
      directUrl: 'https://r/a.png',
    });
    expect(parseImageOutput(JSON.stringify({ image_path: 'x.webp' }))).toEqual({ imagePath: 'x.webp', directUrl: null });
  });

  test('a bare quoted path and a path inside prose', () => {
    expect(parseImageOutput('"workspace/out.png"')).toEqual({ imagePath: '/workspace/out.png', directUrl: null });
    expect(parseImageOutput('Saved image to /tmp/gen/cat.jpg successfully')).toEqual({
      imagePath: '/tmp/gen/cat.jpg',
      directUrl: null,
    });
    expect(parseImageOutput('')).toEqual({ imagePath: null, directUrl: null });
  });

  test('the title follows the action, falling back to "Image Gen"', () => {
    expect(imageGenTitle('edit')).toBe('Edit Image');
    expect(imageGenTitle('remove_bg')).toBe('Remove Background');
    expect(imageGenTitle(undefined)).toBe('Image Gen');
  });
});

describe('video gen output', () => {
  test('finds a sandbox video path or a direct URL', () => {
    expect(parseVideoOutput(JSON.stringify({ path: '/workspace/v.mp4' }))).toEqual({
      videoPath: '/workspace/v.mp4',
      directUrl: null,
    });
    expect(parseVideoOutput(JSON.stringify({ video_url: 'https://r/v.mp4' }))).toEqual({
      videoPath: null,
      directUrl: 'https://r/v.mp4',
    });
    expect(parseVideoOutput('Video saved to /workspace/out/clip.webm')).toEqual({
      videoPath: '/workspace/out/clip.webm',
      directUrl: null,
    });
    expect(parseVideoOutput('Error: quota')).toEqual({ videoPath: null, directUrl: null });
  });
});

describe('presentation gen', () => {
  test('the action label and subtitle per action', () => {
    expect(presentationActionLabel('create_slide')).toBe('Create Slide');
    expect(presentationActionLabel('custom_thing')).toBe('custom_thing');
    expect(
      presentationTriggerSubtitle({ action: 'create_slide', presentationName: 'deck', slideTitle: 'Intro', slideNumber: 2 }),
    ).toBe('Slide 2: Intro');
    expect(presentationTriggerSubtitle({ action: 'export_pdf', presentationName: 'deck' })).toBe('deck → PDF');
    expect(presentationTriggerSubtitle({ action: 'export_pptx', presentationName: 'deck' })).toBe('deck → PPTX');
    expect(presentationTriggerSubtitle({ action: 'list_presentations' })).toBe('All presentations');
    expect(presentationTriggerSubtitle({ action: 'validate_slide' })).toBe('Slide ?');
    expect(presentationTriggerSubtitle({ action: 'other' })).toBe('other');
  });

  test('which actions draw their own success line', () => {
    expect(presentationHasOwnSuccessLine('create_slide')).toBe(true);
    expect(presentationHasOwnSuccessLine('serve')).toBe(true);
    expect(presentationHasOwnSuccessLine('list_slides')).toBe(false);
    expect(presentationHasOwnSuccessLine(undefined)).toBe(false);
  });
});
