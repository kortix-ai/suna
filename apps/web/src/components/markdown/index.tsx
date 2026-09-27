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
