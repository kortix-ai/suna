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
export { ClickableInlineCode } from './inline-code';
// From the server-safe module, not through the client one: re-exporting a
// plain function out of a `'use client'` file hands a server consumer a client
// reference, which throws the moment it is CALLED. See `inline-chip.tsx`.
export { HexColorCode, INLINE_CODE, isHexColor } from './inline-chip';
export { MarkdownCode } from './markdown-code';
