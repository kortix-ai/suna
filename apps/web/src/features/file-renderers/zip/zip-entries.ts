/**
 * The shape of a zip, worked out from its entry list.
 *
 * Pure and React-free on purpose: everything that can be wrong about an
 * archive — traversal paths, folders that exist only as a prefix, resource
 * forks, an entry too big to preview — is decided here and unit-tested without
 * loading a real zip or mounting anything.
 *
 * `zip-renderer.tsx` is the only consumer. It owns bytes and pixels; this owns
 * the truth about what is inside.
 */

/** One file inside the archive. Directories are folders, not entries. */
export interface ZipEntry {
  /**
   * The key jszip knows this entry by — the archive's own bytes, verbatim.
   *
   * Separate from `path` because `safeZipPath` REWRITES a hostile path, and a
   * rewritten path is not a key: `zip.file('etc/passwd')` finds nothing in an
   * archive whose entry is called `../../etc/passwd`. Look up with this, show
   * and download with `path`.
   */
  rawPath: string;
  /** Full path inside the archive, sanitized for display: no leading slash,
   *  no traversal segments, POSIX separators. */
  path: string;
  /** The last segment — what the row shows. */
  name: string;
  /** UNCOMPRESSED size in bytes, which is what "how big is this file" means
   *  to a reader. Zip stores it per entry, so nothing has to be inflated to
   *  answer. */
  size: number;
  /** Entry mtime, or null when the archive did not record one. */
  date: Date | null;
}

export interface ZipFolder {
  /** Full path, `''` for the archive root. */
  path: string;
  name: string;
  folders: ZipFolder[];
  files: ZipEntry[];
}

/**
 * Stop drawing rows past this. A zip is a container, not a file system browser
 * — `node_modules.zip` holds ~200k entries and rendering them all locks the
 * tab for seconds to answer a question ("what is this?") that the first
 * hundred already answered.
 *
 * The renderer must SAY when it truncates. Silent truncation reads as "this is
 * the whole archive", which is the one thing a file list must never get wrong.
 */
export const MAX_ZIP_ENTRIES = 2000;

/**
 * Inflate an entry for preview only under this. Above it the row offers
 * Extract instead — decompressing 400MB into a string to show the first
 * screenful is how a preview pane takes the tab down with it.
 */
export const MAX_ZIP_PREVIEW_BYTES = 2 * 1024 * 1024;

/**
 * Archive-internal bookkeeping, not the user's files.
 *
 * `__MACOSX/` holds the AppleDouble resource forks macOS writes beside every
 * entry when it compresses from Finder — one `._name` per real file, so a
 * 12-file zip lists 24 rows and half of them are unopenable 200-byte
 * duplicates of names already on screen. `.DS_Store` is the same class of
 * thing. Neither is content anyone zipped on purpose.
 *
 * This is the only filtering that happens: a hidden dotfile the user actually
 * authored still lists.
 */
export function isArchiveNoise(path: string): boolean {
  if (path === '.DS_Store' || path.endsWith('/.DS_Store')) return true;
  if (path === '__MACOSX' || path.startsWith('__MACOSX/')) return true;
  // AppleDouble sidecars also appear outside __MACOSX when a zip is rebuilt.
  const name = path.split('/').pop() ?? '';
  return name.startsWith('._');
}

/**
 * Make an entry path safe to show and to name a download after.
 *
 * Zip is a format, not a promise: nothing stops an entry being called
 * `../../.ssh/authorized_keys` (zip-slip) or `C:\docs\report.pdf`. We never
 * write to disk, so neither can become a traversal here — but the path is
 * rendered, and it names a download, where a `../` segment is the browser's
 * problem rather than ours.
 *
 * This is the SECOND line, not the first: jszip runs its own `resolve()` over
 * entry names on both write and load, so `..` is already gone by the time an
 * entry reaches here (pinned in zip-renderer.test.ts). What jszip does NOT
 * touch is backslash separators and drive letters, which is where this
 * function still earns its place — and keeping the `..` filter costs nothing
 * and survives a jszip that stops normalizing.
 *
 * Returns `''` for an entry whose path is nothing but traversal; callers skip
 * those rather than draw a nameless row.
 */
export function safeZipPath(rawPath: string): string {
  return rawPath
    .replace(/\\/g, '/')
    .replace(/^[a-zA-Z]:/, '')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .join('/');
}

/**
 * Group a flat entry list into folders.
 *
 * Zip has no directory tree — it is a flat list of paths, and a folder exists
 * only because some entry's path has that prefix. Archives written by `zip -r`
 * include explicit directory entries; archives written by libraries often do
 * not. Deriving folders from the paths themselves handles both, so an archive
 * without directory records does not render as a hundred slash-laden rows.
 *
 * Files and folders are each sorted by name (case-insensitive, numeric-aware,
 * so `img2` precedes `img10`), folders first — the ordering every file browser
 * uses, and the one a reader is already scanning for.
 */
export function buildZipTree(entries: ReadonlyArray<ZipEntry>): ZipFolder {
  const root: ZipFolder = { path: '', name: '', folders: [], files: [] };
  const byPath = new Map<string, ZipFolder>([['', root]]);

  const folderAt = (path: string): ZipFolder => {
    const existing = byPath.get(path);
    if (existing) return existing;
    const cut = path.lastIndexOf('/');
    const parent = folderAt(cut === -1 ? '' : path.slice(0, cut));
    const folder: ZipFolder = {
      path,
      name: cut === -1 ? path : path.slice(cut + 1),
      folders: [],
      files: [],
    };
    parent.folders.push(folder);
    byPath.set(path, folder);
    return folder;
  };

  for (const entry of entries) {
    const cut = entry.path.lastIndexOf('/');
    folderAt(cut === -1 ? '' : entry.path.slice(0, cut)).files.push(entry);
  }

  const compare = (a: string, b: string) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  const sort = (folder: ZipFolder) => {
    folder.folders.sort((a, b) => compare(a.name, b.name));
    folder.files.sort((a, b) => compare(a.name, b.name));
    folder.folders.forEach(sort);
  };
  sort(root);

  return root;
}

/**
 * The folders to open on first paint.
 *
 * A zip of a project is almost always one wrapper folder — `report.zip`
 * containing `report/` — and opening onto a single closed row that says
 * `report` tells the reader nothing they did not already know from the
 * filename. Descend while a folder is an only child with no files beside it,
 * so the first thing on screen is real content.
 *
 * Stops at the first branch. Auto-opening past a fork would be guessing which
 * side the reader wanted.
 */
export function autoOpenFolders(root: ZipFolder): string[] {
  const open: string[] = [];
  let node = root;
  while (node.files.length === 0 && node.folders.length === 1) {
    node = node.folders[0];
    open.push(node.path);
  }
  return open;
}

export interface ZipSummary {
  files: number;
  folders: number;
  /** Total uncompressed bytes. */
  bytes: number;
}

/** Header line: what the reader gets before opening anything. */
export function zipSummary(root: ZipFolder): ZipSummary {
  let files = 0;
  let folders = 0;
  let bytes = 0;
  const walk = (folder: ZipFolder) => {
    files += folder.files.length;
    for (const file of folder.files) bytes += file.size;
    folders += folder.folders.length;
    folder.folders.forEach(walk);
  };
  walk(root);
  return { files, folders, bytes };
}

/**
 * How an entry can be shown without leaving the archive.
 *
 * Deliberately NOT the full `getFileCategory` ladder. Those renderers fetch by
 * path from a `FileSource`, and an entry inside a zip has no path any source
 * can resolve — plus half of them offer editing and saving, which cannot mean
 * anything for bytes locked in a container. Two kinds are honest here; for
 * everything else Extract is the real answer, and saying so beats a preview
 * pane that renders mojibake.
 */
export type ZipPreviewKind = 'text' | 'image' | 'none';

const PREVIEWABLE_IMAGES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'ico']);

/**
 * Text formats that survive being read as UTF-8. This mirrors the renderer's
 * own text path rather than delegating to `getLanguageFromExt`, because that
 * function answers "how do I syntax-highlight this", which is a different
 * question from "will decoding these bytes produce readable characters".
 */
const PREVIEWABLE_TEXT = new Set([
  'txt', 'md', 'mdx', 'markdown', 'log', 'csv', 'tsv',
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'xml', 'ini', 'cfg', 'conf', 'properties', 'env',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp',
  'cs', 'swift', 'kt', 'php', 'sql', 'sh', 'bash', 'zsh', 'fish',
  'html', 'htm', 'css', 'scss', 'less', 'svg', 'vue', 'svelte', 'graphql', 'gql',
]);

/** Extensionless files that are text by convention — a bare `LICENSE` or
 *  `Dockerfile` is exactly the kind of thing a reader opens a zip to check. */
const PREVIEWABLE_BASENAMES = new Set([
  'license', 'licence', 'readme', 'changelog', 'authors', 'notice', 'makefile', 'dockerfile',
  'gitignore', 'dockerignore', 'npmrc', 'nvmrc', 'editorconfig', 'gitattributes',
]);

export function zipPreviewKind(name: string): ZipPreviewKind {
  const lower = name.toLowerCase();
  const ext = lower.includes('.') ? (lower.split('.').pop() ?? '') : '';
  if (PREVIEWABLE_IMAGES.has(ext)) return 'image';
  if (PREVIEWABLE_TEXT.has(ext)) return 'text';
  // `.gitignore` reads as extension "gitignore" above; a bare `LICENSE` has no
  // dot at all. Both land here.
  if (PREVIEWABLE_BASENAMES.has(lower.replace(/^\./, '').split('.')[0])) return 'text';
  return 'none';
}

/**
 * Whether this entry may be inflated for preview.
 *
 * Size is checked against the UNCOMPRESSED figure, which is the whole point:
 * a 4MB zip can hold a 900MB log, and the compressed size says nothing about
 * what decompressing it costs. (That gap is also what a zip bomb is.)
 */
export function canPreviewZipEntry(entry: ZipEntry): boolean {
  return zipPreviewKind(entry.name) !== 'none' && entry.size <= MAX_ZIP_PREVIEW_BYTES;
}

/**
 * What an archive download is saved as.
 *
 * `FileContentRenderer` already hands the renderer a basename, so the split is
 * belt-and-braces for any caller that passes a path. The fallback matters more:
 * an empty `download` attribute makes the browser name the file after the blob
 * URL — a UUID with no extension, which then will not open.
 */
export function archiveFileName(fileName: string): string {
  const base = fileName.split('/').pop()?.trim();
  return base || 'archive.zip';
}
