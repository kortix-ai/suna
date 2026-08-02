// The one import path for code rendering: `@/components/markdown/code`.
//
// The rule: own frame → `HighlightedCode`. Want a finished card →
// `CodeHighlight`. Inside markdown → nothing, `MarkdownCode` handles it.
// `CopyOverlay` floats a copy button over any of them.
//
// The palette is a parameter: `MARKDOWN_THEME` (default) or `PIERRE_THEME` for
// surfaces sitting beside a diff or the CodeMirror editor.

export { CodeBlock, CodeHighlight, HighlightedCode } from './code-block';
export { CopyOverlay } from './copy-overlay';
export { ClickableInlineCode, INLINE_CODE } from './inline-code';
export { MarkdownCode } from './markdown-code';
export {
  MARKDOWN_THEME,
  PIERRE_THEME,
  SHIKI_THEME_DARK,
  SHIKI_THEME_LIGHT,
  type CodeTheme,
} from './shiki-highlighter';
