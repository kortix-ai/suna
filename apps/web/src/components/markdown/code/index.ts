// The one import path for code rendering: `@/components/markdown/code`.
//
// The rule: own frame → `HighlightedCode`. Want a finished card →
// `CodeHighlight`. Inside markdown → nothing, `MarkdownCode` handles it.
// `CopyOverlay` floats a copy button over any of them.
//
// The palette is not a parameter. Every surface renders under the one pair in
// `@/lib/code-theme`; `HighlightedCode` picks the half from the active theme.

export { CodeBlock, CodeHighlight, HighlightedCode } from './code-block';
export { CopyOverlay } from './copy-overlay';
export { ClickableInlineCode, INLINE_CODE } from './inline-code';
export { MarkdownCode } from './markdown-code';
export { SHIKI_THEME_DARK, SHIKI_THEME_LIGHT, type CodeThemeName } from './shiki-highlighter';
