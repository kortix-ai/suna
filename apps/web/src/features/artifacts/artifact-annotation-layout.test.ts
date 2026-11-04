import { expect, test } from 'bun:test';
import { parseArtifactAnnotationFrameMessage, type ArtifactAnnotationLayout } from '@kortix/shared/artifact-annotations';
import type { ArtifactCommentAnchor } from '@kortix/shared/artifact-comments';
import { assembleArtifactAnnotationLayout, resolveArtifactAnnotationAnchor } from './artifact-annotation-layout';

const viewport = { width: 800, height: 600, scroll: { x: 0, y: 200 } };
const rect = { x: 10, y: 230, width: 400, height: 100 };
const chunk = (overrides: Partial<ArtifactAnnotationLayout> = {}): ArtifactAnnotationLayout => ({
  kortix: 'annotate', v: 1, type: 'layout', revision: 1, chunk: 0, final: true, complete: true, viewport,
  elements: [{ n: 0, selector: '#forecast', snippet: 'Forecast', rect }],
  texts: [{ n: 0, offset: 0, text: 'Forecast' }], ...overrides,
});
const textAnchor = (quote = 'Forecast', prefix = '', suffix = ''): ArtifactCommentAnchor => ({ type: 'text', version: 'vc_one', quote, prefix, suffix });
const pointAnchor = (overrides: Record<string, unknown> = {}): ArtifactCommentAnchor => ({
  type: 'point', version: 'vc_one', selector: '#forecast', snippet: 'Forecast', viewport_width: 800,
  scroll: { x: 0, y: 200 }, offset: { x: 0.25, y: 0.5 }, ...overrides,
}) as ArtifactCommentAnchor;
const resolve = (anchor: ArtifactCommentAnchor, chunks = [chunk()], version = 'vc_two') =>
  resolveArtifactAnnotationAnchor(anchor, assembleArtifactAnnotationLayout(chunks)!, version);

test('ordered final chunks assemble a raw rope and immutable source offsets', () => {
  const chunks = [chunk({ final: false, texts: [{ n: 0, offset: 0, text: 'First ' }] }),
    chunk({ chunk: 1, elements: [], texts: [{ n: 0, offset: 6, text: 'bold' }, { n: 2, offset: 0, text: 'next' }] })];
  const inventory = assembleArtifactAnnotationLayout(chunks)!;
  expect(inventory.text).toBe('First boldnext');
  expect(inventory.spans).toEqual([{ n: 0, offset: 0, start: 0, end: 6 }, { n: 0, offset: 6, start: 6, end: 10 }, { n: 2, offset: 0, start: 10, end: 14 }]);
  expect(inventory.complete).toBe(true);
  chunks[0]!.texts[0]!.text = 'changed';
  expect(inventory.texts[0]!.text).toBe('First ');
});

test('missing, reordered, duplicate, mixed-revision, and invalid-offset inventories fail closed', () => {
  const incomplete = chunk({ final: false });
  for (const chunks of [[], [incomplete], [chunk({ chunk: 1 })], [chunk(), chunk({ chunk: 1 })],
    [incomplete, chunk({ chunk: 1, revision: 2 })],
    [incomplete, chunk({ chunk: 1 })],
    [chunk({ texts: [{ n: 0, offset: 1, text: 'gap' }] })],
    [chunk({ texts: [{ n: 0, offset: 0, text: 'one' }, { n: 0, offset: 2, text: 'overlap' }] })],
    [chunk({ texts: [{ n: 1, offset: 0, text: 'first' }, { n: 0, offset: 0, text: 'backward' }] })],
    [incomplete, chunk({ chunk: 1, viewport: { ...viewport, width: 900 } })]]) {
    expect(assembleArtifactAnnotationLayout(chunks)).toBeNull();
  }
});

test('text anchors map across text-node and segment boundaries without adding block whitespace', () => {
  const chunks = [chunk({ texts: [{ n: 0, offset: 0, text: 'First ' }, { n: 1, offset: 0, text: 'bold' }, { n: 2, offset: 0, text: 'next' }] })];
  const result = resolve(textAnchor('st boldne'), chunks);
  expect(result).toMatchObject({ status: 'resolved', outdated: false, position: { start: 3, end: 12 }, rects: [],
    ranges: [{ n: 0, start: 3, end: 6 }, { n: 1, start: 0, end: 4 }, { n: 2, start: 0, end: 2 }] });
  const segmented = [chunk({ texts: [{ n: 0, offset: 0, text: 'First ' }, { n: 0, offset: 6, text: 'bold' }] })];
  expect(resolve(textAnchor('st bold'), segmented).ranges).toEqual([{ n: 0, start: 3, end: 10 }]);
});

test('text reanchoring preserves exact context ambiguity and existing bounded fuzzy matching', () => {
  const repeated = [chunk({ texts: [{ n: 0, offset: 0, text: 'old Forecast bad then new Forecast good' }] })];
  expect(resolve(textAnchor('Forecast'), repeated).status).toBe('outdated');
  expect(resolve(textAnchor('Forecast', 'new ', ' good'), repeated).position).toEqual({ start: 26, end: 34 });
  expect(resolve(textAnchor('abcdefghij'), [chunk({ texts: [{ n: 0, offset: 0, text: 'prefix abcxefghij suffix' }] })]).position).toEqual({ start: 7, end: 17 });
  expect(resolve(textAnchor('missing')).outdated).toBe(true);
});

test('UTF16 positions preserve emoji and never send half-surrogate DOM ranges', () => {
  const chunks = [chunk({ texts: [{ n: 0, offset: 0, text: 'A🚀' }, { n: 1, offset: 0, text: 'B' }] })];
  expect(resolve(textAnchor('🚀B'), chunks).ranges).toEqual([{ n: 0, start: 1, end: 3 }, { n: 1, start: 0, end: 1 }]);
  expect(resolve(textAnchor('Xabcdefghij'), [chunk({ texts: [{ n: 0, offset: 0, text: '🚀abcdefghij' }] })]).status).toBe('outdated');
});

test('verified selector wins while unique exact snippet fallback follows selector drift', () => {
  const elements = [chunk().elements[0]!, { n: 1, selector: '#other', snippet: 'Forecast', rect }];
  expect(resolve(pointAnchor(), [chunk({ elements })]).position).toEqual({ start: 0, end: 1 });
  expect(resolve(pointAnchor({ selector: '#old' }), [chunk()]).position).toEqual({ start: 0, end: 1 });
  expect(resolve(pointAnchor({ selector: '#old' }), [chunk({ elements })]).status).toBe('outdated');
  expect(resolve(pointAnchor({ snippet: 'Forecast changed' })).status).toBe('outdated');
});

test('point and region fractions produce document geometry and element order for the sidebar', () => {
  expect(resolve(pointAnchor())).toMatchObject({ status: 'resolved', position: { start: 0, end: 1 }, ranges: [], rects: [{ x: 110, y: 280, width: 1, height: 1 }] });
  const region = pointAnchor({ type: 'region', offset: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 } });
  expect(resolve(region).rects).toEqual([{ x: 50, y: 250, width: 200, height: 40 }]);
});

test('an empty snippet can resolve only its original selector at the same Files commit', () => {
  const anchor = pointAnchor({ snippet: '' });
  const chunks = [chunk({ elements: [{ ...chunk().elements[0]!, snippet: '' }] })];
  expect(resolve(anchor, chunks, 'vc_one').status).toBe('resolved');
  expect(resolve(anchor, chunks, 'vc_two').status).toBe('outdated');
  expect(resolve(pointAnchor({ selector: '#old', snippet: '' }), chunks, 'vc_one').status).toBe('outdated');
});

test('truncated inventories preserve unknown text and missing geometry without guessing outdated', () => {
  const partial = [chunk({ complete: false })];
  for (const anchor of [textAnchor(), textAnchor('missing'), pointAnchor({ selector: '#old' }), pointAnchor({ snippet: 'missing' })]) {
    expect(resolve(anchor, partial)).toMatchObject({ status: 'unknown', outdated: undefined, position: null, rects: [], ranges: [] });
  }
  expect(resolve(pointAnchor(), partial).status).toBe('resolved');
  const empty = [chunk({ complete: false, elements: [{ ...chunk().elements[0]!, snippet: '' }] })];
  expect(resolve(pointAnchor({ snippet: '' }), empty, 'vc_one').status).toBe('resolved');
  expect(resolve(pointAnchor({ snippet: '' }), empty, 'vc_two').status).toBe('unknown');
});

test('global inventory caps apply across individually valid bounded messages', () => {
  const chunks = Array.from({ length: 9 }, (_, index) => chunk({ chunk: index, final: index === 8, elements: [],
    texts: Array.from({ length: 15 }, (_, n) => ({ n: index * 15 + n, offset: 0, text: 'x'.repeat(4096) })) }));
  expect(chunks.every(part => parseArtifactAnnotationFrameMessage(part))).toBe(true);
  expect(assembleArtifactAnnotationLayout(chunks)).toBeNull();
  expect(assembleArtifactAnnotationLayout(Array.from({ length: 257 }, (_, index) => chunk({ chunk: index, final: index === 256, elements: [], texts: [] })))).toBeNull();
});

test('unsupported geometry remains unknown, and unanchored comments need no location', () => {
  const huge = [chunk({ elements: [{ ...chunk().elements[0]!, rect: { x: 9_000_000, y: 0, width: 9_000_000, height: 1 } }] })];
  expect(resolve(pointAnchor({ offset: { x: 1, y: 1 } }), huge).status).toBe('unknown');
  expect(resolve({ type: 'none', version: 'vc_one' }, [chunk({ complete: false })])).toMatchObject({ status: 'resolved', outdated: false, position: null, rects: [], ranges: [] });
});
