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
import { readFile } from 'node:fs/promises'
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
// Linear: `[^"]*` stops at the next quote. `promptFileReferenceXml` writes `path` then `mime`.
const FILE_TAG = /<file path="([^"]*)" mime="([^"]*)"/g

const unescapeXml = (value: string) =>
  value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

function decodeDataUrl(url: string): { mime: string; bytes: Uint8Array } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  return match ? { mime: match[1]!, bytes: Buffer.from(match[2]!, 'base64') } : null
}

/**
 * The prompt's images: its data-URL image parts and the inbox images its `<file>` tags name, each
 * resized by pi. A file outside the inbox, unreadable, or that pi cannot resize is left out.
 */
export async function promptImages(
  input: { text: string; files: Array<{ mime: string; url: string }> },
  workspace: string,
  resize: ResizeImage,
): Promise<ImageContent[]> {
  const inbox = resolve(workspace, 'uploads', '.kortix-inbox') + sep
  const sources: Array<Promise<{ mime: string; bytes: Uint8Array } | null>> = []
  for (const file of input.files) {
    if (file.mime.startsWith('image/')) sources.push(Promise.resolve(decodeDataUrl(file.url)))
  }
  for (const [, rawPath, mime] of input.text.matchAll(FILE_TAG)) {
    const path = resolve(unescapeXml(rawPath!))
    if (!INLINE.has(unescapeXml(mime!)) || !path.startsWith(inbox)) continue
    sources.push(readFile(path).then((bytes) => ({ mime: unescapeXml(mime!), bytes }), () => null))
  }
  const images: ImageContent[] = []
  for (const source of await Promise.all(sources)) {
    const resized = source && (await resize(source.bytes, source.mime).catch(() => null))
    if (resized) images.push({ type: 'image', data: resized.data, mimeType: resized.mimeType })
  }
  return images
}
