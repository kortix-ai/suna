// The one import path for the code COMPONENTS: `@/components/markdown/code`.
//
// The rule: own frame → `HighlightedCode`. Want a finished card →
// `CodeHighlight`. Inside markdown → nothing, `MarkdownCode` handles it.
// `CopyOverlay` floats a copy button over any of them.
//
// The palette is not a parameter. Every surface renders under the one pair in
// `@/lib/code-theme` — that module, not this barrel, is the import path for
// the theme constants; `HighlightedCode` picks the half from the active theme.

export { childrenToText } from './children-text';
export { CodeBlock, CodeHighlight, HighlightedCode } from './code-block';
export { CopyOverlay } from './copy-overlay';
export { ClickableInlineCode, INLINE_CODE } from './inline-code';
export { MarkdownCode } from './markdown-code';
