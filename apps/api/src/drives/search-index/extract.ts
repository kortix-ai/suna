// What the search index keeps of one file: its text, when it is a text-like
// file, cut at a fixed size. Pure, so the rules are tested without storage.

import { createHash } from 'node:crypto';

/** The most text one index row keeps (UTF-8 bytes). Longer files are cut; a search finds what is in the first 256 KiB. */
export const INDEX_BODY_BYTES = 256 * 1024;

/** The most bytes the indexer reads of one file: HTML loses its markup first, so it reads more. */
export function indexReadBytes(path: string): number {
  return isHtml(path) ? 1024 * 1024 : INDEX_BODY_BYTES;
}

const TEXT_EXTENSIONS = new Set([
  // prose and notes
  'md', 'markdown', 'mdx', 'txt', 'text', 'rst', 'adoc', 'org', 'tex', 'log',
  // data
  'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'xml',
  // web
  'html', 'htm', 'css', 'scss', 'less', 'vue', 'svelte',
  // code
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h',
  'cc', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'sql', 'lua', 'r', 'scala', 'dart',
  'ex', 'exs', 'erl', 'hs', 'clj', 'graphql', 'gql', 'proto', 'tf', 'hcl', 'dockerfile', 'makefile',
]);

/** Files with no extension that are text by name. */
const TEXT_NAMES = new Set(['readme', 'license', 'changelog', 'makefile', 'dockerfile', 'procfile', 'gemfile', 'notice']);

/**
 * Names whose content stays out of the index even when it is text: env
 * files and private keys. They keep a name row; their bytes open only
 * through Files, where reading them is a deliberate act.
 */
const SECRET_NAME = /^\.env(\..*)?$|\.(pem|key|p12|pfx)$|^id_(rsa|ed25519|ecdsa|dsa)$/i;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function isHtml(path: string): boolean {
  const ext = extensionOf(baseName(path));
  return ext === 'html' || ext === 'htm';
}

/** Whether the indexer reads this file's bytes (by name; the bytes are checked too, see {@link extractText}). */
export function isTextLike(path: string): boolean {
  const name = baseName(path);
  if (!name || SECRET_NAME.test(name)) return false;
  const ext = extensionOf(name);
  if (ext) return TEXT_EXTENSIONS.has(ext);
  return TEXT_NAMES.has(name.toLowerCase());
}

/** Markup out, text in: scripts, styles and tags removed, the common entities decoded, whitespace folded. */
export function stripHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/** `text` cut to at most `maxBytes` UTF-8 bytes, never inside a character. */
export function cutUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= maxBytes) return text;
  let end = maxBytes;
  // Back off a continuation byte (10xxxxxx) so the cut lands on a character start.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

export interface ExtractedText {
  /** The text the index keeps; empty for a binary file. */
  body: string;
  /** sha256 of the bytes read, hex. */
  contentHash: string;
}

/**
 * The index text of a file's first bytes (`bytes` is at most
 * {@link indexReadBytes}). A NUL in the first 8 KiB marks the file binary:
 * it keeps an empty body. Invalid UTF-8 becomes U+FFFD; a character the read
 * cut in half at the end is dropped.
 */
export function extractText(path: string, bytes: Uint8Array): ExtractedText {
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  if (bytes.subarray(0, 8192).includes(0)) return { body: '', contentHash };
  let text = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(bytes);
  text = text.replace(/�+$/, '').replace(/\u0000/g, '');
  if (isHtml(path)) text = stripHtml(text);
  return { body: cutUtf8(text, INDEX_BODY_BYTES), contentHash };
}

/** A volume listing's `mtime` (seconds or milliseconds since the epoch) as a Date; null when absent. */
export function mtimeDate(mtime: number | null | undefined): Date | null {
  const n = Number(mtime ?? 0);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n < 1e12 ? n * 1000 : n);
}
