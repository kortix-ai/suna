/**
 * A minimal, bounded ZIP reader — enough to read a craft out of an uploaded
 * archive, and deliberately nothing more.
 *
 * No dependency: `Bun.inflateSync` handles the only compression method that
 * matters (method 8, deflate), and method 0 (stored) needs no decompression at
 * all. Everything else is 30 bytes of header parsing per entry. Pulling in a
 * general-purpose zip library would add transitive surface to the API for a
 * feature whose entire input is a handful of text files.
 *
 * It is a LEAF (imports nothing) so the parsing rules are testable without the
 * env graph — and because the last thing the projects import path needs is
 * another heavy module (see `shared/github-fetch.ts` and the 2026-08-30
 * learning).
 *
 * **Every bound here is a security control, not a nicety.** The input is an
 * untrusted upload, so a zip bomb, a traversal path, or a 4 GB entry must be
 * refused by construction rather than caught downstream.
 */

/** One extracted file. `path` is normalized, repo-relative and traversal-free. */
export interface ZipEntry {
  path: string;
  content: string;
  bytes: number;
}

export interface ZipReadLimits {
  /** Total uncompressed bytes across all kept entries. */
  maxTotalBytes: number;
  /** Uncompressed bytes for any single entry. */
  maxEntryBytes: number;
  /** How many entries may be kept. */
  maxEntries: number;
}

export const CRAFT_ZIP_LIMITS: ZipReadLimits = {
  // Total EXTRACTED TEXT we keep, not the archive envelope — that is
  // `MAX_UPLOAD_BYTES` in `crafts/index.ts`, checked on the declared size
  // before any read.
  //
  // Raised 1 MB → 5 MB on 2026-08-30. A craft is a manifest plus agent `.md`
  // files and skill folders, so a real one is tens of KB; the old cap was
  // rejecting people who zipped a whole repo folder with docs and fixtures in
  // it, which is the obvious thing to do and was never the failure we wanted to
  // catch. 5 MB still refuses "someone zipped their node_modules".
  //
  // Note what this does NOT change: `maxEntryBytes` stays at 256 KB, because a
  // single 5 MB text file is not craft content, and the install prompt has its
  // own tighter budget (`CRAFT_INSTALL_EMBED_BUDGET`) since an upload's files
  // travel to the agent inside the prompt.
  maxTotalBytes: 5_000_000,
  maxEntryBytes: 256_000,
  // Counted AFTER `isCraftContentPath`, so this bounds craft files — agent
  // `.md`s and skill folders — not the size of the repo someone zipped.
  // Raised 200 → 1000 on 2026-08-30: a craft with many skills is legitimate,
  // and 200 was low enough that a real one could hit it.
  maxEntries: 1000,
};

export type ZipReadErrorCode =
  | 'not_a_zip'
  | 'truncated'
  | 'unsupported_compression'
  | 'too_large'
  | 'too_many_entries'
  | 'unsafe_path'
  | 'encrypted';

export class ZipReadError extends Error {
  constructor(
    readonly code: ZipReadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ZipReadError';
  }
}

// ── ZIP structure constants (PKWARE APPNOTE) ────────────────────────────────
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
/** The comment field is 16 bits, so the EOCD starts at most 65535+22 from the end. */
const EOCD_MAX_SEARCH = 0xffff + EOCD_MIN_SIZE;

/**
 * Text extensions a craft may contain. An ALLOWLIST, not a denylist: the files
 * are read as UTF-8 and shown to an agent, so a binary that happens to decode
 * is worse than a file we simply refuse to carry.
 */
const TEXT_EXTENSIONS = new Set([
  '.yaml',
  '.yml',
  '.toml',
  '.md',
  '.mdx',
  '.json',
  '.jsonc',
  '.txt',
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.sh',
  '.py',
]);

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot).toLowerCase();
}

export function isCraftTextPath(path: string): boolean {
  if (path.endsWith('.env.example')) return true;
  return TEXT_EXTENSIONS.has(extensionOf(path));
}

/**
 * Whether a path is part of the CRAFT, as opposed to part of the repo the craft
 * happens to live in.
 *
 * This is the filter that lets someone zip a whole project folder. A craft IS
 * its manifest plus `.kortix/` — the agent `.md`s and skill directories the
 * install copies. Application source (`src/**.ts`, tests, configs) has no role
 * in installing a craft INTO another project, and keeping it would be actively
 * wrong: the install prompt says "these ARE the craft — copy from here", so a
 * stored `src/server.ts` becomes a file the agent writes into someone else's
 * repo.
 *
 * Deliberately narrow, and anchored:
 *   - the manifest, at the ROOT only — `crawlCraftZip` looks for it exactly
 *     there (`manifestCandidatePaths(null)`), so a nested `kortix.yaml` is a
 *     different project's manifest, not this craft's.
 *   - anything under a `.kortix/` directory at any depth — agents, skills,
 *     opencode config. A skill's bundled helper script lives here too, which is
 *     the documented convention and why no extra allowance is needed for it.
 *   - `README.md` at the root, which is what a person reads before installing.
 *   - `.env.example` at the root, which declares what the craft needs.
 */
export function isCraftContentPath(path: string): boolean {
  if (!isCraftTextPath(path)) return false;
  // `.kortix/` at any depth (a monorepo may hold `apps/foo/.kortix/`).
  if (path === '.kortix' || path.startsWith('.kortix/') || path.includes('/.kortix/')) return true;
  // Root-anchored: no '/' left in the path means it sits at the archive root.
  if (path.includes('/')) return false;
  const base = path.toLowerCase();
  if (/^kortix\.(ya?ml|toml)$/.test(base)) return true;
  if (/^readme\.mdx?$/.test(base)) return true;
  return base === '.env.example';
}

/**
 * Normalize an archive path to a safe repo-relative one, or null to refuse it.
 *
 * Refuses absolute paths, any `..` segment, Windows drive letters and NUL —
 * every one of which is a way to make an extracted path escape its root. Also
 * strips a single leading directory, because every archive GitHub produces (and
 * every `zip -r` of a checkout) wraps the tree in one folder.
 */
export function normalizeZipPath(raw: string, stripRoot: string | null): string | null {
  if (!raw || raw.includes('\0')) return null;
  let path = raw.replace(/\\/g, '/');
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return null;
  if (stripRoot && path.startsWith(`${stripRoot}/`)) path = path.slice(stripRoot.length + 1);
  // Drop `./` noise, then refuse anything that still tries to climb.
  const parts = path.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) return null;
  const joined = parts.join('/');
  return joined || null;
}

/**
 * The single top-level directory every entry shares, or null when the archive
 * is already rooted at the tree. This is what makes a GitHub "Download ZIP"
 * (which wraps everything in `<repo>-<ref>/`) behave like a `zip -r` of a
 * checkout.
 */
export function detectSingleRoot(paths: readonly string[]): string | null {
  const tops = new Set<string>();
  let sawNested = false;
  for (const p of paths) {
    const clean = p.replace(/\\/g, '/');
    const slash = clean.indexOf('/');
    if (slash === -1) {
      // A file at the archive root means there is no single wrapper directory.
      if (clean) return null;
      continue;
    }
    sawNested = true;
    tops.add(clean.slice(0, slash));
    if (tops.size > 1) return null;
  }
  if (!sawNested || tops.size !== 1) return null;
  const [only] = [...tops];
  return only || null;
}

interface CentralEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  flags: number;
}

function findEocd(view: DataView): number {
  const start = Math.max(0, view.byteLength - EOCD_MAX_SEARCH);
  for (let i = view.byteLength - EOCD_MIN_SIZE; i >= start; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  throw new ZipReadError('not_a_zip', 'no ZIP end-of-central-directory record found');
}

function readCentralDirectory(view: DataView, bytes: Uint8Array): CentralEntry[] {
  const eocd = findEocd(view);
  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (cdOffset >= view.byteLength) {
    throw new ZipReadError('truncated', 'central directory offset is past the end of the file');
  }

  const entries: CentralEntry[] = [];
  let cursor = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > view.byteLength) {
      throw new ZipReadError('truncated', 'central directory entry runs past the end of the file');
    }
    if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      throw new ZipReadError('not_a_zip', 'bad central-directory signature');
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const nameStart = cursor + 46;
    if (nameStart + nameLength > view.byteLength) {
      throw new ZipReadError('truncated', 'central-directory filename runs past the end');
    }
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength));
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset, flags });
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Body bytes of one entry, read via its LOCAL header (the authority on offset). */
function entryBody(view: DataView, bytes: Uint8Array, entry: CentralEntry): Uint8Array {
  const at = entry.localOffset;
  if (at + 30 > view.byteLength) {
    throw new ZipReadError('truncated', `local header for "${entry.name}" is past the end`);
  }
  if (view.getUint32(at, true) !== LOCAL_SIGNATURE) {
    throw new ZipReadError('not_a_zip', `bad local header signature for "${entry.name}"`);
  }
  const nameLength = view.getUint16(at + 26, true);
  const extraLength = view.getUint16(at + 28, true);
  const start = at + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > view.byteLength) {
    throw new ZipReadError('truncated', `body of "${entry.name}" runs past the end`);
  }
  return bytes.subarray(start, end);
}

/**
 * Read the text files out of a ZIP archive.
 *
 * Non-text files, directories and over-sized entries are SKIPPED, not fatal —
 * an archive is somebody's repo and will contain a `.png` or a lockfile we
 * simply do not need. What DOES throw is "this is not a readable archive" or
 * "this input is hostile".
 */
export function readZipTextFiles(
  input: ArrayBuffer | Uint8Array,
  limits: ZipReadLimits = CRAFT_ZIP_LIMITS,
): { files: ZipEntry[]; skipped: string[]; ignored: string[]; root: string | null } {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < EOCD_MIN_SIZE) {
    throw new ZipReadError('not_a_zip', 'file is too small to be a ZIP archive');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const central = readCentralDirectory(view, bytes);

  const root = detectSingleRoot(central.map((e) => e.name));
  const files: ZipEntry[] = [];
  const skipped: string[] = [];
  // Text files that are simply not craft content — the bulk of a repo zip.
  // Reported separately from `skipped` so a warning can distinguish "we could
  // not carry this" from "this is not part of a craft".
  const ignored: string[] = [];
  let total = 0;

  for (const entry of central) {
    // Bit 0 of the general-purpose flags is "encrypted". We cannot read it and
    // must not pretend the archive was empty.
    if (entry.flags & 0x1) {
      throw new ZipReadError('encrypted', `"${entry.name}" is encrypted`);
    }
    // A directory entry, by the trailing-slash convention.
    if (entry.name.endsWith('/')) continue;

    const path = normalizeZipPath(entry.name, root);
    if (!path) {
      // A traversal or absolute path is hostile, not incidental. Refuse the
      // whole archive rather than silently dropping the interesting entry.
      throw new ZipReadError('unsafe_path', `"${entry.name}" is not a safe relative path`);
    }
    if (!isCraftTextPath(path)) {
      skipped.push(path);
      continue;
    }
    // Checked BEFORE maxEntries, which is the whole point: a 900-file
    // application source tree must not consume the craft-file budget.
    if (!isCraftContentPath(path)) {
      ignored.push(path);
      continue;
    }
    if (entry.uncompressedSize > limits.maxEntryBytes) {
      skipped.push(path);
      continue;
    }
    if (files.length >= limits.maxEntries) {
      throw new ZipReadError(
        'too_many_entries',
        `archive holds more than ${limits.maxEntries} text files`,
      );
    }
    if (total + entry.uncompressedSize > limits.maxTotalBytes) {
      throw new ZipReadError(
        'too_large',
        `archive's text files exceed ${limits.maxTotalBytes} bytes uncompressed`,
      );
    }

    const body = entryBody(view, bytes, entry);
    let raw: Uint8Array;
    if (entry.method === 0) {
      raw = body;
    } else if (entry.method === 8) {
      // `body` is a subarray VIEW over the upload's buffer; Bun's types want an
      // owned `Uint8Array<ArrayBuffer>`, so copy the slice rather than widening
      // the cast and losing the check.
      raw = Bun.inflateSync(new Uint8Array(body)) as Uint8Array;
    } else {
      throw new ZipReadError(
        'unsupported_compression',
        `"${path}" uses compression method ${entry.method}; only stored and deflate are supported`,
      );
    }
    // Re-check against what ACTUALLY came out: a zip bomb lies in its header,
    // so the declared size is a claim and never a trusted bound.
    if (raw.byteLength > limits.maxEntryBytes || total + raw.byteLength > limits.maxTotalBytes) {
      throw new ZipReadError('too_large', `"${path}" is larger than its header claimed`);
    }
    total += raw.byteLength;
    files.push({ path, content: new TextDecoder().decode(raw), bytes: raw.byteLength });
  }

  return { files, skipped, ignored, root };
}
