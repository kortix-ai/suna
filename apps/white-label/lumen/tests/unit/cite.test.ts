import { describe, expect, test } from 'bun:test';
import vectors from '../../agent-kit/shared/cite-vectors.json';
import { normalize, sectionCitations, verifyCitation } from '../../convex/lib/cite';

describe('citation normalization (shared vectors, same file as the kit selftest)', () => {
  for (const c of vectors.cases) {
    test(c.name, () => expect(normalize(c.para).includes(normalize(c.quote))).toBe(c.ok));
  }
});

describe('verifyCitation', () => {
  const paras = [
    { page: 1, para: 1, text: 'Master Services Agreement' },
    { page: 3, para: 12, text: '11.1 Neither party’s liability under this Agreement shall be limited.' },
  ];
  test('verified, relocated, unverified', () => {
    expect(verifyCitation({ doc_id: 'd', a: 'p3.12', quote: "Neither party's liability" }, paras)).toEqual({ status: 'verified', a: 'p3.12' });
    expect(verifyCitation({ doc_id: 'd', a: 'p1.1', quote: 'shall be limited' }, paras)).toEqual({ status: 'relocated', a: 'p3.12' });
    expect(verifyCitation({ doc_id: 'd', a: 'p3.12', quote: 'liability is unlimited' }, paras).status).toBe('unverified');
    expect(verifyCitation({ doc_id: 'd', a: 'p3.12', quote: 'x'.repeat(301) }, paras).status).toBe('unverified');
  });
});

describe('sectionCitations', () => {
  test('adds every body /cite link the list misses, once', () => {
    const listed = [{ doc_id: 'd1', a: 'p1.1', quote: 'cap applies' }];
    const body = 'A [1](/cite?d=d1&a=p1.1&q=cap%20applies) B [2](/cite?d=d2&a=p3.4&q=five%20years) C [3](/cite?d=d2&a=p3.4&q=five%20years) D [x](/cite?d=d3&a=p1.1)';
    expect(sectionCitations(listed, body)).toEqual([listed[0], { doc_id: 'd2', a: 'p3.4', quote: 'five years' }]);
  });
});
