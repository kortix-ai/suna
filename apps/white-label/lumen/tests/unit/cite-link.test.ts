import { expect, test } from 'bun:test';
import { parseCite } from '@/lib/cite-link';

test('parseCite reads doc, anchor and the decoded quote from relative and absolute links', () => {
  const q = encodeURIComponent('Neither party’s liability & costs');
  expect(parseCite(`/cite?d=kn7abc&a=p3.12&q=${q}`)).toEqual({ d: 'kn7abc', a: 'p3.12', q: 'Neither party’s liability & costs' });
  expect(parseCite(`http://localhost:3020/cite?d=kn7abc&a=p1.2&q=x`)).toEqual({ d: 'kn7abc', a: 'p1.2', q: 'x' });
});

test('parseCite refuses other links and a link without a document or anchor', () => {
  for (const href of [null, '', '/app/matters', '/cite?d=kn7abc', '/cite?a=p1.1', '/citex?d=a&a=p1.1', 'http://[bad']) {
    expect(parseCite(href)).toBeNull();
  }
});
