import type { ArtifactCommentThread } from '@kortix/sdk';
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArtifactDrawingLayer } from './artifact-drawing-layer';

const viewport = { width: 800, height: 600, scroll: { x: 10, y: 50 } };
const regions = { thread: { x: 100, y: 200, width: 200, height: 100 } };
const mark = {
  tool: 'pen',
  color: 'red',
  width: 0.01,
  points: [
    { x: 0.1, y: 0.2 },
    { x: 0.5, y: 0.8 },
  ],
};
const thread = {
  thread_id: 'thread',
  status: 'open',
  outdated: false,
  anchor: {
    type: 'region',
    version: 'commit',
    selector: '#target',
    snippet: 'Target',
    viewport_width: 800,
    scroll: { x: 0, y: 0 },
    offset: { x: 0, y: 0, width: 1, height: 1 },
  },
  comments: [{ comment_id: 'comment', deleted_at: null, marks: [mark] }],
} as unknown as ArtifactCommentThread;
function html(value = thread, width = 800, focusedThreadId: string | null = null) {
  return renderToStaticMarkup(
    <ArtifactDrawingLayer
      threads={[value]}
      viewport={{ ...viewport, width }}
      regions={regions}
      focusedThreadId={focusedThreadId}
    />,
  );
}

test('stored marks project relative to the resolved region and current scroll', () => {
  const result = html();
  expect(result).toContain('points="110,170 190,230"');
  expect(result).toContain('stroke="red"');
  expect(result).toContain('stroke-width="2"');
  expect(result).toContain('pointer-events-none');
});

test('a different viewport shows stored marks on the screenshot only', () => {
  expect(html(thread, 720)).not.toContain('<polyline');
  expect(html({ ...thread, outdated: true })).not.toContain('<polyline');
});

test('resolved marks appear only for focused threads and malformed persisted data never becomes SVG', () => {
  expect(html({ ...thread, status: 'resolved' })).not.toContain('<polyline');
  expect(html({ ...thread, status: 'resolved' }, 800, 'thread')).toContain('<polyline');
  const invalid = {
    ...thread,
    comments: [{ ...thread.comments[0]!, marks: [{ ...mark, color: 'url(private)' }] }],
  };
  expect(html(invalid)).not.toContain('url(private)');
  expect(html(invalid)).not.toContain('<polyline');
});

test('a pen tap remains a visible dot after its duplicate-point API roundtrip', () => {
  const point = { x: 0.1, y: 0.2 };
  const value = {
    ...thread,
    comments: [{ ...thread.comments[0]!, marks: [{ ...mark, points: [point, point] }] }],
  };
  const result = html(value);
  expect(result).toContain('<circle cx="110" cy="170" r="1" fill="red"');
  expect(result).not.toContain('<polyline');
});
