import type { ClassifiedPart } from '@kortix/sdk';
import { expect, test } from 'bun:test';
import { userMessageParts } from '../../src/components/chat/user-message-parts';

const file: ClassifiedPart = {
  kind: 'file', id: 'attachment', filename: 'notes.txt', mime: 'text/plain',
  url: 'data:text/plain,notes', isImage: false, isPdf: false,
};
const text = (value: string): ClassifiedPart => ({ kind: 'text', id: value, text: value, synthetic: false });

test('a file-only user turn retains its attachment', () => {
  expect(userMessageParts([file])).toEqual({ text: '', parts: [file] });
});

test('mixed user turns preserve non-text order and plain text', () => {
  const patch: ClassifiedPart = { kind: 'patch', id: 'patch', fileCount: 1, files: ['notes.txt'], hash: 'synthetic' };
  expect(userMessageParts([text(' **literal** '), file, text('last'), patch])).toEqual({
    text: '**literal** \nlast', parts: [file, patch],
  });
});

test('empty and whitespace-only user turns stay empty', () => {
  expect(userMessageParts([])).toEqual({ text: '', parts: [] });
  expect(userMessageParts([text('  ')])).toEqual({ text: '', parts: [] });
});
