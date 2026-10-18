/**
 * Compiled into a binary by `pi-images.test.ts`: the daemon's image paths in a compiled
 * binary. Prints what pi's `read` tool returns for argv[2] and what `promptImages` attaches for a
 * prompt whose `<file>` tag names it (argv[3] is the workspace).
 */
import { createReadToolDefinition, resizeImage } from '@earendil-works/pi-coding-agent'
import { promptImages } from '@/harness/pi/images'

const [file, workspace] = process.argv.slice(2) as [string, string]
const read = await createReadToolDefinition(workspace).execute('call', { path: file }, undefined, undefined, undefined as never)
const prompt = await promptImages({ text: `<file path="${file}" mime="image/png" filename="x.png">\n</file>`, files: [] }, workspace, resizeImage)
console.log(JSON.stringify({ read: read.content, prompt }))
