import { describe, expect, test } from 'bun:test';

import { closeUnterminatedCodeFence, holdBackFenceOpener, holdBackTableHeader } from './throttled-markdown';

describe('holdBackTableHeader', () => {
  test('holds back a header row until its separator arrives', () => {
    expect(holdBackTableHeader('Intro\n\n| Name | Age |')).toBe('Intro\n');
    expect(holdBackTableHeader('Intro\n\n| Name | Age |\n')).toBe('Intro\n');
    expect(holdBackTableHeader('Intro\n\n| Name')).toBe('Intro\n');
  });

  test('holds back a header and a half-written separator', () => {
    expect(holdBackTableHeader('Intro\n\n| Name | Age |\n|---')).toBe('Intro\n');
    expect(holdBackTableHeader('Intro\n\n| Name | Age |\n| --- |')).toBe('Intro\n');
  });

  test('shows the table once the separator is complete', () => {
    const text = 'Intro\n\n| Name | Age |\n| --- | --- |';
    expect(holdBackTableHeader(text)).toBe(text);
  });

  test('leaves body rows and plain text alone', () => {
    const rows = 'Intro\n\n| Name | Age |\n|---|---|\n| Ada | 36';
    expect(holdBackTableHeader(rows)).toBe(rows);
    expect(holdBackTableHeader('no table here')).toBe('no table here');
  });
});

describe('holdBackFenceOpener', () => {
  test('holds back a fence opener whose language tag is still arriving', () => {
    expect(holdBackFenceOpener('Intro\n\n```openu')).toBe('Intro\n\n');
    expect(holdBackFenceOpener('Intro\n\n```')).toBe('Intro\n\n');
  });

  test('shows the fence once its line is complete, and never holds a closing fence', () => {
    expect(holdBackFenceOpener('Intro\n\n```openui\n')).toBe('Intro\n\n```openui\n');
    const closing = 'Intro\n\n```ts\nconst a = 1\n```';
    expect(holdBackFenceOpener(closing)).toBe(closing);
  });
});

describe('closeUnterminatedCodeFence', () => {
  test('closes an unterminated code fence', () => {
    expect(closeUnterminatedCodeFence('```ts\nconst a = 1')).toBe('```ts\nconst a = 1\n\n```');
  });

  test('leaves an open generative UI fence open: UnifiedMarkdown reads it as streaming and closes it', () => {
    const open = 'Intro\n\n```openui\nroot = Stack([a])';
    expect(closeUnterminatedCodeFence(open)).toBe(open);
  });
});
