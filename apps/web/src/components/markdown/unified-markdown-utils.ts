import { looksLikeFilePath as sharedLooksLikeFilePath } from '@/lib/utils/path-detection';

// Pure, deterministic helpers used by the unified markdown renderer. Extracted
// so they can be unit-tested without pulling in React / Shiki / Streamdown.

/** Same-origin link? Internal links route through next/link; the rest open externally. */
export function isInternalUrl(href: string | undefined): boolean {
  if (!href) return false;
  if (href.startsWith('http://') || href.startsWith('https://')) return false;
  if (href.includes('://')) return false;
  return href.startsWith('/') || href.startsWith('#');
}

/** Normalise a fenced-code language hint to a Shiki grammar id. */
export function normalizeLanguage(lang: string): string {
  const map: Record<string, string> = {
    htm: 'html',
    js: 'javascript',
    ts: 'typescript',
    jsx: 'jsx',
    tsx: 'tsx',
    py: 'python',
    rb: 'ruby',
    yml: 'yaml',
    sh: 'bash',
    shell: 'bash',
    zsh: 'bash',
    md: 'markdown',
  };
  return map[lang.toLowerCase()] || lang.toLowerCase();
}

/** Display label for the code-block header; empty hint falls back to "text". */
export function languageLabel(language: string): string {
  if (!language) return 'text';
  const lower = language.toLowerCase();
  const display: Record<string, string> = {
    js: 'javascript',
    ts: 'typescript',
    py: 'python',
    rb: 'ruby',
    sh: 'bash',
    shell: 'bash',
    zsh: 'bash',
    yml: 'yaml',
    md: 'markdown',
    htm: 'html',
  };
  return display[lower] || lower;
}

const FILE_EXTENSION_RE = /\.\w{1,10}$/;
const COMMON_NON_FILES = new Set(['e.g.', 'i.e.', 'etc.', 'vs.', 'v1.', 'v2.']);

/** Does this inline-code text look like a clickable URL? */
export function looksLikeUrl(text: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(text);
}

/** Does this inline-code text look like a file path we can open in a preview? */
export function looksLikeFilePath(text: string): boolean {
  if (!text || text.length < 3 || text.length > 300) return false;
  if (text.includes(' ') || text.includes('\n')) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return false;
  if (COMMON_NON_FILES.has(text.toLowerCase())) return false;
  if (!text.includes('/')) return false;
  if (FILE_EXTENSION_RE.test(text)) return true;
  return sharedLooksLikeFilePath(text);
}
