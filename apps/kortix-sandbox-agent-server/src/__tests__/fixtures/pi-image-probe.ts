/**
 * Compiled into a binary by `pi-images.test.ts`: the daemon's image paths in a compiled
 * binary. Prints what pi's `read` tool returns for argv[2], what `promptImages` attaches for a
 * prompt whose `<file>` tag names it (argv[3] is the workspace), and whether photon loaded on this
 * thread (pi resizes in its worker, src/utils/image-resize-worker.ts, or on the daemon loop).
 */
import { createRequire } from 'node:module'
import { createReadToolDefinition, resizeImage } from '@earendil-works/pi-coding-agent'
import { promptImages } from '@/harness/pi/images'

// photon-node reads its wasm with this `fs.readFileSync` when it loads on this thread; a worker has its own `fs`.
const fs = createRequire(import.meta.url)('fs') as typeof import('node:fs')
const readFileSync = fs.readFileSync
let photonOnMainThread = false
fs.readFileSync = function (this: unknown, file: unknown, ...rest: unknown[]) {
  if (typeof file === 'string' && file.endsWith('/photon_rs_bg.wasm')) photonOnMainThread = true
  return Reflect.apply(readFileSync, this, [file, ...rest])
} as typeof fs.readFileSync

const [file, workspace] = process.argv.slice(2) as [string, string]
const read = await createReadToolDefinition(workspace).execute('call', { path: file }, undefined, undefined, undefined as never)
const prompt = await promptImages({ text: `<file path="${file}" mime="image/png" filename="x.png">\n</file>`, files: [] }, workspace, resizeImage)
console.log(JSON.stringify({ read: read.content, prompt, photonOnMainThread }))
