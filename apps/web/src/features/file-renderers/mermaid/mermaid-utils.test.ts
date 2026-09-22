import { getFileCategory, getLanguageFromExt } from '@/features/file-viewer/file-content-renderer';
import { languageFor } from '@/features/session/action-panel/easy/file-viewer';
import { fileIconFor } from '@/lib/utils/file-utils';
import { TreeStructureIcon } from '@phosphor-icons/react';
import { describe, expect, test } from 'bun:test';
import {
  hasOwnMermaidConfig,
  isMermaidFile,
  mermaidSvgFileName,
  toMermaidParseError,
  withIntrinsicSize,
  withViewerTheme,
} from './mermaid-utils';

describe('extension → renderer mapping', () => {
  test('the Files viewer treats .mmd and .mermaid as Mermaid text', () => {
    expect(getLanguageFromExt('flow.mmd')).toBe('mermaid');
    expect(getLanguageFromExt('docs/flow.MERMAID')).toBe('mermaid');
    expect(getFileCategory('flow.mmd')).toBe('code');
    expect(getLanguageFromExt('README.md')).toBe('markdown');
  });

  test('the session panel highlights Mermaid source with the mermaid grammar', () => {
    expect(languageFor('flow.mmd')).toBe('mermaid');
    expect(languageFor('flow.mermaid')).toBe('mermaid');
  });

  test('.mmd files get the diagram icon', () => {
    expect(fileIconFor('flow.mmd')).toBe(TreeStructureIcon);
    expect(fileIconFor('flow.mermaid')).toBe(TreeStructureIcon);
  });

  test('isMermaidFile matches only diagram extensions', () => {
    expect(isMermaidFile('/workspace/a.mmd')).toBe(true);
    expect(isMermaidFile('a.mermaid')).toBe(true);
    expect(isMermaidFile('a.md')).toBe(false);
    expect(isMermaidFile('mmd')).toBe(false);
  });
});

describe('mermaidSvgFileName', () => {
  test('swaps the diagram extension for .svg', () => {
    expect(mermaidSvgFileName('flow.mmd')).toBe('flow.svg');
    expect(mermaidSvgFileName('/workspace/docs/arch.mermaid')).toBe('arch.svg');
    expect(mermaidSvgFileName('notes')).toBe('notes.svg');
  });
});

describe('withViewerTheme', () => {
  test('appends a theme directive so front matter stays on line 1', () => {
    const src = '---\ntitle: Flow\n---\nflowchart TD\n  A --> B';
    const out = withViewerTheme(src, true);
    expect(out.startsWith(src)).toBe(true);
    expect(out).toContain('"theme":"dark"');
    expect(out).toContain('"htmlLabels":false');
    expect(withViewerTheme('flowchart TD\n A-->B', false)).toContain('"theme":"neutral"');
  });

  test('keeps the author theme when the file configures Mermaid itself', () => {
    const directive = "%%{init: {'theme': 'forest'}}%%\nflowchart TD\n A-->B";
    const front = '---\nconfig:\n  theme: forest\n---\nflowchart TD\n A-->B';
    expect(hasOwnMermaidConfig(directive)).toBe(true);
    expect(hasOwnMermaidConfig(front)).toBe(true);
    expect(withViewerTheme(directive, true)).toBe(directive);
    expect(withViewerTheme(front, true)).toBe(front);
    expect(hasOwnMermaidConfig('---\ntitle: x\n---\nflowchart TD')).toBe(false);
  });
});

describe('toMermaidParseError', () => {
  test('reads the line from a Jison parse message', () => {
    const err = new Error("Parse error on line 3:\n...A --> \n-----^\nExpecting 'NODE_STRING'");
    expect(toMermaidParseError(err).line).toBe(3);
  });

  test('falls back to the Jison hash location', () => {
    const err = Object.assign(new Error('Unexpected token'), { hash: { loc: { first_line: 7 } } });
    expect(toMermaidParseError(err)).toEqual({ message: 'Unexpected token', line: 7 });
  });

  test('points an unknown diagram type at line 1', () => {
    const err = new Error('No diagram type detected matching given configuration for text: foo');
    expect(toMermaidParseError(err).line).toBe(1);
  });

  test('handles non-Error throws', () => {
    expect(toMermaidParseError('boom')).toEqual({ message: 'boom', line: null });
  });
});

describe('withIntrinsicSize', () => {
  test('replaces width="100%" and max-width with the viewBox size', () => {
    const svg =
      '<svg id="m" width="100%" xmlns="http://www.w3.org/2000/svg" style="max-width: 812.5px;" viewBox="-8 -8 812.5 400"><g/></svg>';
    const out = withIntrinsicSize(svg);
    expect(out).toContain('<svg width="812.5" height="400" id="m"');
    expect(out).not.toContain('100%');
    expect(out).not.toContain('max-width');
    expect(out.endsWith('<g/></svg>')).toBe(true);
  });

  test('leaves an SVG without a viewBox untouched', () => {
    const svg = '<svg width="10" height="10"></svg>';
    expect(withIntrinsicSize(svg)).toBe(svg);
  });
});
