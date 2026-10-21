import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { hasUnlinkedCitations, parseCite, unlinkedAnswerId } from '@/lib/cite-link';

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

describe('hasUnlinkedCitations: a finished answer citing a bare [n] is flagged', () => {
  const doc = (html: string) => {
    const d = new Window().document;
    d.body.innerHTML = html;
    return d.body as unknown as ParentNode;
  };
  test('bare [1] in a finished answer: flagged; linked, streaming or no markers: not', () => {
    expect(hasUnlinkedCitations(doc('<div class="kortix-markdown" data-streaming="false">Uncapped [1].</div>'))).toBe(true);
    expect(hasUnlinkedCitations(doc('<div class="kortix-markdown" data-streaming="false">Uncapped <a href="/cite?d=x&a=p1.1&q=y">[1]</a>.</div>'))).toBe(false);
    expect(hasUnlinkedCitations(doc('<div class="kortix-markdown" data-streaming="true">Uncapped [1].</div>'))).toBe(false);
    expect(hasUnlinkedCitations(doc('<div class="kortix-markdown" data-streaming="false">No markers.</div><p>[1] in a user bubble</p>'))).toBe(false);
    // The rewrite with links clears the banner the bare answer above it raised (UXR3-3).
    expect(hasUnlinkedCitations(doc('<div class="kortix-markdown" data-streaming="false">Uncapped [1].</div><div class="kortix-markdown" data-streaming="false">Uncapped <a href="/cite?d=x&a=p1.1&q=y">[1]</a>.</div>'))).toBe(false);
  });
});

test('unlinkedAnswerId: the last answer with bare [n] markers and no /cite link (UXR3-3)', () => {
  const user = { info: { id: 'u1', role: 'user' }, parts: [{ type: 'text', text: 'Which agreements are uncapped?' }] };
  const bare = { info: { id: 'a1', role: 'assistant' }, parts: [{ type: 'tool', text: '' }, { type: 'text', text: 'The MSA is uncapped [1]. Sources: msa.pdf' }] };
  const linked = { info: { id: 'a2', role: 'assistant' }, parts: [{ type: 'text', text: 'The MSA is uncapped [1](/cite?d=x&a=p2.1&q=y).' }] };
  const plain = { info: { id: 'a3', role: 'assistant' }, parts: [{ type: 'text', text: 'No agreement is uncapped.' }] };
  expect(unlinkedAnswerId([user, bare])).toBe('a1');
  expect(unlinkedAnswerId([user, linked])).toBeNull();
  expect(unlinkedAnswerId([user, plain])).toBeNull();
  expect(unlinkedAnswerId([bare, user])).toBeNull();
  expect(unlinkedAnswerId([])).toBeNull();
});
