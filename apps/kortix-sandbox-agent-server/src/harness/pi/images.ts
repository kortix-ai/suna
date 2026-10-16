/**
 * The images a pi prompt hands the model.
 *
 * apps/api writes every prompt attachment to `<workspace>/uploads/.kortix-inbox/` and puts a
 * `<file path="…" mime="…">` tag in the prompt text: nothing rides inline in the prompt body
 * (`prompt-attachment-materializer.ts`). For a model that reads images, the runtime also attaches
 * each image such a tag names. The tag stays, so the agent still has the path.
 *
 * pi resizes every image (the `read` tool's and the prompt's) with photon. photon-node reads
 * `photon_rs_bg.wasm` from its own `__dirname` when it loads, and a compiled daemon bakes the BUILD
 * machine's `__dirname`. On a box that read failed, photon never loaded, and pi dropped every
 * image ("[Image omitted: could not be resized below the inline image size limit.]"). pi's own
 * fallback looks next to the executable, where a box has no copy. So the binary embeds the wasm
 * (the import below), and a read of that file name goes to the embedded copy.
 */
import { createRequire } from 'node:module'
import { readFile, realpath, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import type { ImageContent } from '@earendil-works/pi-ai'
// Bun embeds a `.wasm` import in a compiled binary and evaluates it to a readable path (codemode.ts).
import photonWasmPath from '@silvia-odwyer/photon-node/photon_rs_bg.wasm'

// ponytail: a process-wide redirect of one file name. Drop it once pi takes the wasm path (as
// `setEmbeddedQuickJSWasmPath` for codemode). photon-node's CJS `require('fs')` is this object.
const fs = createRequire(import.meta.url)('fs') as typeof import('node:fs')
const readFileSync = fs.readFileSync
fs.readFileSync = function (this: unknown, file: unknown, ...rest: unknown[]) {
  return Reflect.apply(readFileSync, this, [typeof file === 'string' && file.endsWith('/photon_rs_bg.wasm') ? photonWasmPath : file, ...rest])
} as typeof fs.readFileSync

/** pi's `resizeImage`: fits an image under the inline size limit, or null when it cannot. */
export type ResizeImage = (bytes: Uint8Array, mime: string) => Promise<{ data: string; mimeType: string } | null>

/** The image types a model takes inline (`isModelNativeAttachmentMime` in @kortix/shared). Any other file stays a path. */
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
/** `MAX_PROMPT_ATTACHMENT_FILES` and `MAX_PROMPT_ATTACHMENT_BYTES` in @kortix/shared: what one prompt can carry. */
const MAX_IMAGES = 20
const MAX_BYTES = 50 * 1024 * 1024
// Linear: `[^"]*` stops at the next quote. `promptFileReferenceXml` writes `path` then `mime`.
const FILE_TAG = /<file path="([^"]*)" mime="([^"]*)"/g

const unescapeXml = (value: string) =>
  value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

function decodeDataUrl(url: string): { mime: string; bytes: Uint8Array } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  return match ? { mime: match[1]!, bytes: Buffer.from(match[2]!, 'base64') } : null
}

/**
 * The image files a prompt's `<file>` tags name, in order: inline image types under an
 * `uploads/.kortix-inbox/` directory, each path once. The session-log export reads the same list
 * for `source_path` (session-log.ts).
 */
export function imageTagPaths(text: string): Array<{ path: string; mime: string }> {
  const seen = new Set<string>()
  const tags: Array<{ path: string; mime: string }> = []
  for (const [, rawPath, rawMime] of text.matchAll(FILE_TAG)) {
    const path = resolve(unescapeXml(rawPath!))
    const mime = unescapeXml(rawMime!)
    if (!INLINE.has(mime) || !path.includes(`${sep}uploads${sep}.kortix-inbox${sep}`) || seen.has(path)) continue
    seen.add(path)
    tags.push({ path, mime })
  }
  return tags
}

/** The file's bytes when its real path stays in the inbox and it is a regular file of at most 50 MiB. */
async function readInboxFile(path: string, inbox: string): Promise<Uint8Array | null> {
  const real = await realpath(path).catch(() => null)
  if (!real?.startsWith(inbox)) return null
  const info = await stat(real).catch(() => null)
  if (!info?.isFile() || info.size > MAX_BYTES) return null
  return readFile(real).catch(() => null)
}

/**
 * The prompt's images: its data-URL image parts, then the inbox images its `<file>` tags name, at
 * most 20, read and resized by pi one at a time. A file that resolves outside the inbox, is not a
 * regular file, is over 50 MiB, is unreadable, or that pi cannot resize is left out.
 */
export async function promptImages(
  input: { text: string; files: Array<{ mime: string; url: string }> },
  workspace: string,
  resize: ResizeImage,
): Promise<ImageContent[]> {
  const inbox = await realpath(resolve(workspace, 'uploads', '.kortix-inbox')).then((dir) => dir + sep, () => null)
  const sources: Array<{ mime: string; bytes: () => Promise<Uint8Array | null> }> = []
  for (const file of input.files) {
    const decoded = file.mime.startsWith('image/') ? decodeDataUrl(file.url) : null
    if (decoded) sources.push({ mime: decoded.mime, bytes: async () => decoded.bytes })
  }
  if (inbox) {
    for (const tag of imageTagPaths(input.text)) sources.push({ mime: tag.mime, bytes: () => readInboxFile(tag.path, inbox) })
  }
  const images: ImageContent[] = []
  for (const source of sources.slice(0, MAX_IMAGES)) {
    const bytes = await source.bytes()
    const resized = bytes && (await resize(bytes, source.mime).catch(() => null))
    if (resized) images.push({ type: 'image', data: resized.data, mimeType: resized.mimeType })
  }
  return images
}
