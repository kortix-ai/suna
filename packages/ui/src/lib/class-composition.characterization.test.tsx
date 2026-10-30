import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { cx, DotMatrixBase } from './dotmatrix-core';
import { FileThumbnail } from '../files/renderers/shared/file-thumbnail';

test('class composition preserves duplicates, conflicting utilities and whitespace', () => {
  expect(cx('p-2', false, null, undefined, '', 'p-4', 'p-4', ' x ')).toBe('p-2 p-4 p-4  x ');
  expect(cx()).toBe('');
});

test('dot matrix preserves caller class tokens', () => {
  const html = renderToStaticMarkup(<DotMatrixBase phase="idle" className="p-2 p-4" dotClassName="opacity-0 opacity-100" />);
  expect(html).toContain('p-2 p-4');
  expect(html).toContain('opacity-0 opacity-100');
});

test('file thumbnail preserves conflicting caller and preview classes', () => {
  const html = renderToStaticMarkup(<FileThumbnail file={{ name: 'synthetic.txt', type: 'text/plain' }} className="rounded-none rounded-xl" previewClassName="aspect-video aspect-auto" />);
  expect(html).toContain('rounded-lg border rounded-none rounded-xl');
  expect(html).toContain('[contain:layout_paint] aspect-video aspect-auto');
});
