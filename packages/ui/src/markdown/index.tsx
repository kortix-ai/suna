/**
 * Unified Markdown System
 *
 * Single source of truth for all markdown rendering. Every caller states who
 * wrote the text (`trust`) and, for a markdown file, `variant="document"`;
 * `markdownPolicy` turns those two facts into what the renderer allows.
 */

export { markdownPolicy } from './markdown-policy';
export type { MarkdownPolicy, MarkdownTrust, MarkdownVariant } from './markdown-policy';
export { UnifiedMarkdown } from './unified-markdown';
export type { UnifiedMarkdownProps } from './unified-markdown';
export { CopyOverlay } from './code';
export { CodeHighlight, HighlightedCode } from './code/code-block';
export { INLINE_CODE } from './code/inline-chip';
export { CopyButton } from './copy-button';
export { MarkdownWithFrontmatter } from './markdown-frontmatter';
export { languageLabel, normalizeLanguage } from './unified-markdown-utils';
