import { expect, test } from 'bun:test';
import { visibleMessageAuthors } from './message-authors';

test('only named distinct human authors show, never guess missing authors', () => {
  expect(visibleMessageAuthors({ a: 'Avery', b: 'Blair', legacy: null })).toEqual({ a: 'Avery', b: 'Blair' });
  expect(visibleMessageAuthors({ a: 'Avery', b: 'Avery' })).toEqual({});
  expect(visibleMessageAuthors({ a: 'Avery', legacy: null })).toEqual({});
});
