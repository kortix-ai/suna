import { expect, test } from 'bun:test';

import { parseImageOutput } from './image-output-path';

test('parses a JSON payload with a path field', () => {
  expect(parseImageOutput('{"path": "/workspace/out.png"}')).toEqual({
    imagePath: '/workspace/out.png',
    directUrl: null,
  });
});

test('parses a JSON payload pointing outside the workspace', () => {
  expect(parseImageOutput('{"output_path": "/tmp/gmail_invite_list.png"}')).toEqual({
    imagePath: '/tmp/gmail_invite_list.png',
    directUrl: null,
  });
});

test('parses a JSON payload with a direct url', () => {
  expect(parseImageOutput('{"replicate_url": "https://replicate.delivery/x.png"}')).toEqual({
    imagePath: null,
    directUrl: 'https://replicate.delivery/x.png',
  });
});

test('accepts a bare absolute path under any sandbox root', () => {
  expect(parseImageOutput('/tmp/shot.png').imagePath).toBe('/tmp/shot.png');
  expect(parseImageOutput('/home/user/pic.jpeg').imagePath).toBe('/home/user/pic.jpeg');
  expect(parseImageOutput('/workspace/a.webp').imagePath).toBe('/workspace/a.webp');
});

test('normalizes quoted workspace-relative paths', () => {
  expect(parseImageOutput('"workspace/out.png"').imagePath).toBe('/workspace/out.png');
  expect(parseImageOutput('"/tmp/out.png"').imagePath).toBe('/tmp/out.png');
});

test('extracts a non-workspace path from surrounding prose', () => {
  expect(
    parseImageOutput('Saved screenshot to /tmp/gmail_invite_list.png for review').imagePath,
  ).toBe('/tmp/gmail_invite_list.png');
  expect(parseImageOutput('Wrote /workspace/render/out.png successfully').imagePath).toBe(
    '/workspace/render/out.png',
  );
});

test('returns nulls when no image is present', () => {
  expect(parseImageOutput('all done!')).toEqual({ imagePath: null, directUrl: null });
  expect(parseImageOutput('')).toEqual({ imagePath: null, directUrl: null });
  expect(parseImageOutput(null)).toEqual({ imagePath: null, directUrl: null });
});
