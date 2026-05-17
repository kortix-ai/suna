/**
 * CodeMirror theme that mirrors Pierre Dark / Pierre Light, the same palette
 * used by Shiki (markdown code blocks, file thumbnails) and `@pierre/diffs`.
 *
 * Without this the file viewer (CodeMirror) and the thumbnail (Shiki) draw
 * the same file with two completely different colour schemes — confusing as
 * hell. This module is the single source of truth that brings them in line.
 *
 * Palette source: `@pierre/theme/pierre-{dark,light}` JSON (`colors` block +
 * `semanticTokenColors`). Token mappings: Lezer tags from `@lezer/highlight`
 * matched to Pierre's semantic categories.
 */
import { createTheme } from '@uiw/codemirror-themes';
import { tags as t } from '@lezer/highlight';

// ---------- Pierre Dark palette ----------
const dark = {
  bg: '#070707',
  fg: '#fbfbfb',
  cursor: '#009fff',
  lineHl: '#19283c8c',
  selection: '#19283c',
  selectionMatch: '#009fff4d',
  gutterFg: '#84848A',
  gutterActiveFg: '#adadb1',
  comment: '#84848A',
  string: '#5ecc71',
  number: '#68cdf2',
  regexp: '#64d1db',
  keyword: '#ff678d',
  variable: '#ffa359',
  parameter: '#adadb1',
  property: '#ffa359',
  function: '#9d6afb',
  type: '#d568ea',
  namespace: '#ffca00',
  enumMember: '#08c0ef',
  constant: '#ffd452',
  defaultLib: '#ffca00',
  operator: '#79797F',
  punctuation: '#79797F',
  tag: '#ff6762',
  attribute: '#61d5c0',
  heading: '#ff6762',
  link: '#ff678d',
};

// ---------- Pierre Light palette ----------
const light = {
  bg: '#ffffff',
  fg: '#070707',
  cursor: '#009fff',
  lineHl: '#dfebff8c',
  selection: '#dfebff',
  selectionMatch: '#009fff2e',
  gutterFg: '#84848A',
  gutterActiveFg: '#6C6C71',
  comment: '#84848A',
  string: '#199f43',
  number: '#1ca1c7',
  regexp: '#17a5af',
  keyword: '#fc2b73',
  variable: '#d47628',
  parameter: '#79797F',
  property: '#d47628',
  function: '#7b43f8',
  type: '#c635e4',
  namespace: '#d5a910',
  enumMember: '#08c0ef',
  constant: '#d5a910',
  defaultLib: '#d5a910',
  operator: '#79797F',
  punctuation: '#79797F',
  tag: '#d63a37',
  attribute: '#0a8b76',
  heading: '#d63a37',
  link: '#fc2b73',
};

function buildTheme(theme: 'light' | 'dark', p: typeof dark) {
  return createTheme({
    theme,
    settings: {
      background: p.bg,
      foreground: p.fg,
      caret: p.cursor,
      selection: p.selection,
      selectionMatch: p.selectionMatch,
      lineHighlight: p.lineHl,
      gutterBackground: p.bg,
      gutterForeground: p.gutterFg,
      gutterActiveForeground: p.gutterActiveFg,
      gutterBorder: 'transparent',
    },
    styles: [
      { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: p.comment, fontStyle: 'italic' },
      { tag: [t.string, t.special(t.string), t.regexp], color: p.string },
      { tag: t.regexp, color: p.regexp },
      { tag: [t.number, t.bool, t.null], color: p.number },
      { tag: t.atom, color: p.enumMember },
      { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.modifier, t.operatorKeyword], color: p.keyword },
      { tag: t.definitionKeyword, color: p.keyword },
      { tag: [t.variableName, t.propertyName], color: p.variable },
      { tag: [t.local(t.variableName), t.special(t.variableName)], color: p.variable },
      { tag: t.definition(t.variableName), color: p.variable },
      { tag: t.definition(t.propertyName), color: p.property },
      { tag: [t.function(t.variableName), t.function(t.propertyName)], color: p.function },
      { tag: [t.typeName, t.className, t.namespace], color: p.type },
      { tag: t.constant(t.variableName), color: p.constant },
      { tag: t.standard(t.variableName), color: p.defaultLib },
      { tag: t.operator, color: p.operator },
      { tag: [t.punctuation, t.separator, t.bracket, t.paren, t.brace], color: p.punctuation },
      { tag: t.tagName, color: p.tag },
      { tag: t.attributeName, color: p.attribute, fontStyle: 'normal' },
      { tag: t.attributeValue, color: p.string },
      { tag: t.heading, color: p.heading, fontWeight: 'bold' },
      { tag: [t.link, t.url], color: p.link, textDecoration: 'underline' },
      { tag: t.emphasis, fontStyle: 'italic' },
      { tag: t.strong, fontWeight: 'bold' },
      { tag: t.strikethrough, textDecoration: 'line-through' },
      { tag: t.escape, color: p.number },
      { tag: t.invalid, color: '#ff2e3f' },
    ],
  });
}

export const pierreDarkCm = buildTheme('dark', dark);
export const pierreLightCm = buildTheme('light', light);
