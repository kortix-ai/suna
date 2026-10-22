import path from 'node:path'

/**
 * File content-type + text/binary classification for the daemon file API.
 *
 * OpenCode's /file/content base64-encodes IMAGES only and returns empty content
 * for every other binary (Office docs, PDFs, archives, …). The daemon owns file
 * reads instead, so it must classify and label files itself. We mirror
 * OpenCode's binary-extension set and add the git "NUL byte in the first chunk"
 * heuristic so unknown-extension binaries are still detected.
 */

// Extensions OpenCode treats as binary (sst/opencode File.read `binary` set),
// plus raster image types (OpenCode handles those via a separate image branch).
const BINARY_EXTENSIONS = new Set<string>([
  // executables / objects / libs
  'exe', 'dll', 'pdb', 'bin', 'so', 'dylib', 'o', 'a', 'lib', 'class', 'jar', 'war', 'ear',
  'wasm', 'wat', 'bc', 'll', 'ko', 'sys', 'drv', 'efi', 'rom', 'com', 'dex', 'vdex', 'odex',
  'oat', 'art', 'kotlin_module',
  // audio / video
  'wav', 'mp3', 'ogg', 'oga', 'ogv', 'ogx', 'flac', 'aac', 'wma', 'm4a', 'weba',
  'mp4', 'avi', 'mov', 'wmv', 'flv', 'webm', 'mkv',
  // archives
  'zip', 'tar', 'gz', 'gzip', 'bz', 'bz2', 'bzip', 'bzip2', '7z', 'rar', 'xz', 'lz', 'z',
  // documents
  'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx',
  // disk / package images
  'dmg', 'iso', 'img', 'vmdk', 'apk', 'ipa', 'aab', 'xapk', 'app', 'pkg', 'deb', 'rpm',
  'snap', 'flatpak', 'appimage', 'msi', 'msp',
  // fonts
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // databases
  'sqlite', 'sqlite3', 'db', 'mdb',
  // raster images (svg is XML text → intentionally excluded)
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tiff', 'tif', 'avif', 'heic', 'heif',
])

// Extension → MIME. Falls back to octet-stream (binary) / text/plain (text).
const MIME_TYPES: Record<string, string> = {
  // documents
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  pdf: 'application/pdf',
  // archives
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  // images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  avif: 'image/avif',
  heic: 'image/heic',
  // audio / video
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  aac: 'audio/aac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  // fonts
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  // databases
  sqlite: 'application/vnd.sqlite3',
  sqlite3: 'application/vnd.sqlite3',
  db: 'application/octet-stream',
  // text / code
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  xml: 'application/xml',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  jsx: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
}

/** Lowercase extension without the dot ("" if none). */
export function extOf(filePath: string): string {
  return path.extname(filePath).toLowerCase().replace(/^\./, '')
}

/** True when the extension is a known binary format. */
export function isBinaryExtension(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(extOf(filePath))
}

/**
 * Classify a file's bytes as binary. Known binary extension → binary; otherwise
 * git's heuristic: a NUL byte within the first 8000 bytes means binary. Text
 * (incl. UTF-8 source) effectively never contains NUL, so this is safe.
 */
export function isLikelyBinary(buf: Buffer, filePath: string): boolean {
  if (isBinaryExtension(filePath)) return true
  const sample = buf.subarray(0, 8000)
  return sample.includes(0)
}

/** Best-effort MIME from extension. `binary` picks the right fallback. */
export function mimeTypeFor(filePath: string, binary: boolean): string {
  const known = MIME_TYPES[extOf(filePath)]
  if (known) return known
  return binary ? 'application/octet-stream' : 'text/plain; charset=utf-8'
}
