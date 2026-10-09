import { describe, expect, test } from 'bun:test';
import {
  expandPastedContent,
  neutralizePastedTags,
  newPastedContentId,
  pastedContentBlocks,
  pastedContentXml,
  restorePastedTags,
  serializePromptWithPastes,
  shouldTilePaste,
  splitPastedContent,
  utf8Bytes,
} from './pasted-content';

const paste = (text: string, id = 'abcd1234') => ({ id, text });

describe('shouldTilePaste', () => {
  test('stays inline below both thresholds', () => {
    expect(shouldTilePaste('a'.repeat(999))).toBe(false);
    expect(shouldTilePaste(Array(10).fill('x').join('\n'))).toBe(false);
  });
  test('tiles at 1000 chars or more than 10 lines', () => {
    expect(shouldTilePaste('a'.repeat(1000))).toBe(true);
    expect(shouldTilePaste(Array(11).fill('x').join('\n'))).toBe(true);
  });
  test('trailing newlines are not lines', () => {
    expect(shouldTilePaste(`${Array(10).fill('x').join('\n')}\n`)).toBe(false);
    expect(shouldTilePaste(`${Array(10).fill('x').join('\n')}\n\n\n`)).toBe(false);
    expect(shouldTilePaste(`${Array(10).fill('x').join('\r\n')}\r\n\r\n`)).toBe(false);
    expect(shouldTilePaste(Array(11).fill('x').join('\r\n'))).toBe(true);
  });
});

describe('newPastedContentId', () => {
  test('is 8 lowercase hex chars', () => {
    for (let i = 0; i < 50; i++) expect(newPastedContentId()).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('round trip', () => {
  const bodies = [
    'plain body',
    'has a close </pasted_content> inside',
    'has </PASTED_CONTENT> upper',
    'a file <file path="x">tag</file> inside',
    'line one\r\nline two\r\n',
    'emoji 🚀 and हिन्दी पाठ',
  ];
  for (const body of bodies) {
    test(JSON.stringify(body), () => {
      const p = paste(body);
      const wire = serializePromptWithPastes('question', [p]);
      expect(splitPastedContent(wire)).toEqual({ text: 'question', pastes: [p] });
    });
  }

  test('two pastes keep order', () => {
    const a = paste('first', 'aaaaaaaa');
    const b = paste('second', 'bbbbbbbb');
    const out = splitPastedContent(serializePromptWithPastes('q', [a, b]));
    expect(out).toEqual({ text: 'q', pastes: [a, b] });
  });

  test('pastes only, empty text: no stray blank lines', () => {
    const p = paste('body');
    expect(serializePromptWithPastes('', [p])).toBe(pastedContentXml(p));
    expect(serializePromptWithPastes('q', [])).toBe('q');
  });
});

describe('typed tags', () => {
  test('a typed tag never parses as a tile', () => {
    const wire = serializePromptWithPastes('<pasted_content id="a" chars="1">x</pasted_content>', []);
    expect(pastedContentBlocks(wire)).toEqual([]);
    expect(wire).toContain('&lt;pasted_content');
    expect(neutralizePastedTags('</Pasted_Content>')).toBe('&lt;/Pasted_Content>');
  });
  test('restorePastedTags is the exact inverse, case kept', () => {
    const typed = '<Pasted_Content id="a" chars="1">x</PASTED_CONTENT> and </pasted_content>';
    expect(restorePastedTags(neutralizePastedTags(typed))).toBe(typed);
  });
  test('split and expand give back the typed text, with and without pastes', () => {
    const typed = '<pasted_content id="abcd1234" chars="3">abc</pasted_content> hello';
    expect(splitPastedContent(serializePromptWithPastes(typed, []))).toEqual({ text: typed, pastes: [] });
    const p = paste('body');
    expect(splitPastedContent(serializePromptWithPastes(typed, [p]))).toEqual({ text: typed, pastes: [p] });
    expect(expandPastedContent(serializePromptWithPastes(typed, [p]))).toBe(`body\n\n${typed}`);
    expect(expandPastedContent(serializePromptWithPastes(typed, []))).toBe(typed);
  });
  test('the edit round trip stays escaped on the wire', () => {
    const typed = '<pasted_content id="abcd1234" chars="3">\nabc\n</pasted_content>';
    const wire = serializePromptWithPastes(typed, []);
    const resent = serializePromptWithPastes(splitPastedContent(wire).text, []);
    expect(resent).toBe(wire);
    expect(pastedContentBlocks(resent)).toEqual([]);
  });
});

describe('validation', () => {
  test('chars mismatch is skipped and left as text', () => {
    const wire = '<pasted_content id="a" chars="5">\nabc\n</pasted_content>\n\nhi';
    expect(pastedContentBlocks(wire)).toEqual([]);
    expect(splitPastedContent(wire)).toEqual({ text: wire, pastes: [] });
  });
  test('empty id is skipped', () => {
    expect(pastedContentBlocks('<pasted_content id="" chars="1">\nx\n</pasted_content>')).toEqual([]);
  });
});

describe('expandPastedContent', () => {
  test('gives body + blank line + question', () => {
    const wire = serializePromptWithPastes('question', [paste('the body')]);
    expect(expandPastedContent(wire)).toBe('the body\n\nquestion');
  });
});

describe('utf8Bytes', () => {
  test('counts bytes', () => {
    expect(utf8Bytes('é')).toBe(2);
    expect(utf8Bytes('a')).toBe(1);
  });
});

describe('performance', () => {
  test('240k-char body parses in < 200 ms', () => {
    const p = paste('x'.repeat(240_000));
    const wire = serializePromptWithPastes('q', [p]);
    const t = performance.now();
    const out = splitPastedContent(wire);
    expect(performance.now() - t).toBeLessThan(200);
    expect(out.pastes[0]!.text.length).toBe(240_000);
  });
  test('unclosed openers stay linear', () => {
    const t = performance.now();
    pastedContentBlocks('<pasted_content id="a" chars="1">'.repeat(8000));
    expect(performance.now() - t).toBeLessThan(200);
  });
});
