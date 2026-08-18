/**
 * The one non-trivial decision `attachment-tiles.tsx` makes: how much of a
 * local text/code file to show as a peek behind its icon before the file is
 * even uploaded.
 *
 * Split out so it is testable without mounting a component or faking a
 * `FileReader` — see `attachment-tiles-logic.test.ts`.
 */

/** Extensions worth reading a peek of. Kept intentionally close to "source
 *  code or plain text" — binary formats (images, archives, PDFs) never reach
 *  here since the composer already routes them to the image tile or the bare
 *  icon tile before this is consulted. */
const TEXT_PREVIEW_EXTENSIONS = new Set([
  'js',
  'jsx',
  'ts',
  'tsx',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'c',
  'cpp',
  'h',
  'hpp',
  'css',
  'scss',
  'html',
  'vue',
  'svelte',
  'json',
  'yaml',
  'yml',
  'toml',
  'xml',
  'md',
  'mdx',
  'txt',
  'log',
  'sh',
  'bash',
  'zsh',
  'sql',
  'swift',
  'kt',
  'scala',
  'lua',
  'r',
  'php',
  'pl',
  'ini',
  'conf',
  'env',
  'gitignore',
  'dockerfile',
]);

/** Lower-cased extension with no leading dot, or `''` for an extensionless name. */
export function fileExtension(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() ?? '';
}

/** Whether `extension` (already lower-cased — see {@link fileExtension}) is one
 *  the composer will try to read a text peek from. */
export function isPreviewableTextExtension(extension: string): boolean {
  return TEXT_PREVIEW_EXTENSIONS.has(extension);
}

/**
 * The first `maxLines` lines of a text read.
 *
 * The caller only ever hands this the first 2KB of the file (see the
 * `FileReader.readAsText(file.slice(0, 2048))` call in `attachment-tiles.tsx`),
 * so this rarely has to cut a real line short — it exists so a file with very
 * long or very many short lines in that first slice still renders a tile-sized
 * peek instead of overflowing it.
 */
export function truncateTextPreview(text: string, maxLines = 12): string {
  return text.split('\n').slice(0, maxLines).join('\n');
}
