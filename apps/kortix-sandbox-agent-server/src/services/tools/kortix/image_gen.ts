/**
 * image_gen: the Kortix image generation tool (gpt-image-2 on the project's
 * ChatGPT plan). Kortix maintains this file. A project lists it in
 * kortix.yaml as `image_gen: kortix:image_gen`; a `tools:` list that does
 * not name it still loads it (DEFAULT_ON_KORTIX_TOOLS). `kortix tools eject
 * image_gen` copies it to `tools/image_gen.ts` for the project to own.
 *
 * A call goes to the Kortix LLM gateway (`KORTIX_LLM_BASE_URL`) with the
 * session token (`KORTIX_TOKEN`); the gateway resolves the ChatGPT login, so
 * the box never holds it. The PNG is saved under `<checkout>/output/images/`
 * and the output is `{ path, action, size, model }`: never image bytes.
 *
 * Untrusted text can ask the model to misuse this tool, so the limits are
 * code: a call cap per turn and per session, reference images only from
 * inside the checkout and only real images, an output file name that is a
 * name and never overwrites.
 *
 * The web UI renders a call from the output JSON. A changed copy must keep
 * that shape, or the UI shows the raw output.
 */
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'

/** What a call receives (the project tool contract). `signal` is the turn's: one per turn. */
interface ToolContext {
  sessionId: string
  directory: string
  env: Record<string, string | undefined>
  signal: AbortSignal
}

export const IMAGE_GEN_TURN_LIMIT = 10
export const IMAGE_GEN_SESSION_LIMIT = 50
const MODEL = 'gpt-image-2'
const SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536']
const QUALITIES = ['auto', 'low', 'medium', 'high']
const MAX_REFERENCES = 5
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024
const TIMEOUT_MS = 300_000
const IMAGE_EXTENSIONS: Record<string, 'png' | 'jpeg' | 'webp'> = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp' }
const OUTPUT_NAME = /^[a-z0-9._-]{1,80}\.png$/

// Calls per turn (keyed by the turn's abort signal) and per session, in this process.
const turnCalls = new WeakMap<AbortSignal, number>()
const sessionCalls = new Map<string, number>()

/** The image type its first bytes prove, or null. */
function imageType(bytes: Buffer): 'png' | 'jpeg' | 'webp' | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  return null
}

/** A reference image as a data URL: a real png/jpeg/webp file inside the checkout, symlinks followed. */
function referenceUrl(path: string, directory: string): string {
  let real: string
  try {
    real = realpathSync(resolve(directory, path))
  } catch {
    throw new Error(`Reference image not found: ${path}`)
  }
  const root = realpathSync(directory)
  if (!real.startsWith(`${root}${sep}`)) throw new Error(`Reference image ${path} is outside the workspace.`)
  const expected = IMAGE_EXTENSIONS[extname(real).toLowerCase()]
  if (!expected) throw new Error(`Reference image ${path} is not a png, jpg, jpeg or webp file.`)
  if (statSync(real).size > MAX_REFERENCE_BYTES) throw new Error(`Reference image ${path} is larger than 20 MiB.`)
  const bytes = readFileSync(real)
  const type = imageType(bytes)
  if (type !== expected) throw new Error(`Reference image ${path} is not a ${expected} image.`)
  return `data:image/${type};base64,${bytes.toString('base64')}`
}

/** `<slug of the prompt>-<yyyymmdd-hhmmss>.png` */
function defaultName(prompt: string): string {
  const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-+|-+$/g, '') || 'image'
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  return `${slug}-${stamp}.png`
}

/** Write to `dir/name`, or `name-2`, `name-3`…: an existing file is never replaced. */
function writeNew(dir: string, name: string, bytes: Buffer): string {
  mkdirSync(dir, { recursive: true })
  const base = name.slice(0, -'.png'.length)
  for (let n = 1; ; n++) {
    const path = join(dir, n === 1 ? name : `${base}-${n}.png`)
    try {
      writeFileSync(path, bytes, { flag: 'wx' })
      return path
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
}

/** The gateway's refusal: `{ message, code, suggestion }` or `{ error: { message, code } }`. */
async function refusal(response: Response): Promise<Error> {
  const text = await response.text()
  let body: { message?: string; code?: string; suggestion?: string; error?: { message?: string; code?: string } } = {}
  try {
    body = JSON.parse(text)
  } catch {}
  const code = body.code ?? body.error?.code
  const message = body.message ?? body.error?.message ?? text.slice(0, 500)
  const retry = response.headers.get('retry-after')
  const detail = [message, body.suggestion, retry ? `Retry after ${retry} s.` : ''].filter(Boolean).join(' ')
  return new Error(`Image generation failed (${response.status}${code ? ` ${code}` : ''}): ${detail}`)
}

/** Count a call against the turn and session caps, or refuse it. */
function admit({ sessionId, signal }: ToolContext): void {
  const turn = turnCalls.get(signal) ?? 0
  const session = sessionCalls.get(sessionId) ?? 0
  if (turn >= IMAGE_GEN_TURN_LIMIT) throw new Error(`Image limit for this turn reached (${IMAGE_GEN_TURN_LIMIT}).`)
  if (session >= IMAGE_GEN_SESSION_LIMIT) throw new Error(`Image limit for this session reached (${IMAGE_GEN_SESSION_LIMIT}).`)
  turnCalls.set(signal, turn + 1)
  sessionCalls.set(sessionId, session + 1)
}

export default {
  description: 'Generate or edit an image with gpt-image-2. Saves a PNG under /workspace/output/images/ and returns its path.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['generate', 'edit'], description: '`generate` a new image, or `edit` the reference images.' },
      prompt: { type: 'string', description: 'What the image shows, or what to change.' },
      reference_images: {
        type: 'array',
        items: { type: 'string' },
        description: 'For `edit`: 1–5 workspace paths of png, jpg, jpeg or webp images, each at most 20 MiB.',
      },
      size: { type: 'string', enum: SIZES, description: 'Default: auto.' },
      quality: { type: 'string', enum: QUALITIES, description: 'Default: auto.' },
      transparent_background: { type: 'boolean', description: 'Default: false.' },
      output_name: { type: 'string', description: 'File name only, matching [a-z0-9._-]{1,80}.png. An existing file is never replaced; a suffix is added.' },
    },
    required: ['action', 'prompt'],
  },
  async execute(args: Record<string, any>, context: ToolContext): Promise<string> {
    const action = args.action
    if (action !== 'generate' && action !== 'edit') throw new Error("'action' must be 'generate' or 'edit'.")
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
    if (!prompt) throw new Error("'prompt' is required.")
    const size = args.size ?? 'auto'
    if (!SIZES.includes(size)) throw new Error(`'size' must be one of ${SIZES.join(', ')}.`)
    const quality = args.quality ?? 'auto'
    if (!QUALITIES.includes(quality)) throw new Error(`'quality' must be one of ${QUALITIES.join(', ')}.`)
    if (args.output_name !== undefined && !OUTPUT_NAME.test(String(args.output_name))) {
      throw new Error("'output_name' must be a file name matching [a-z0-9._-]{1,80}.png.")
    }
    const references: unknown[] = args.reference_images ?? []
    if (!Array.isArray(references)) throw new Error("'reference_images' must be a list of paths.")
    if (action === 'edit' && references.length === 0) throw new Error("'reference_images' is required for action 'edit'.")
    if (action === 'generate' && references.length > 0) throw new Error("'reference_images' is only used with action 'edit'.")
    if (references.length > MAX_REFERENCES) throw new Error(`At most ${MAX_REFERENCES} reference images.`)
    const images = references.map((path) => ({ image_url: referenceUrl(String(path), context.directory) }))

    const base = context.env.KORTIX_LLM_BASE_URL?.trim().replace(/\/+$/, '')
    if (!base) throw new Error('KORTIX_LLM_BASE_URL is not set.')
    const token = context.env.KORTIX_TOKEN?.trim()
    if (!token) throw new Error('KORTIX_TOKEN is not set.')
    admit(context)

    const response = await fetch(`${base}/images/${action === 'edit' ? 'edits' : 'generations'}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: `codex/${MODEL}`,
        prompt,
        size,
        quality,
        background: args.transparent_background === true ? 'transparent' : 'auto',
        n: 1,
        ...(images.length ? { images } : {}),
      }),
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(TIMEOUT_MS)]),
    })
    if (!response.ok) throw await refusal(response)
    const data = (await response.json()) as { data?: Array<{ b64_json?: string }>; size?: string }
    const b64 = data.data?.[0]?.b64_json
    if (!b64) throw new Error('Image generation returned no image.')
    const path = writeNew(join(context.directory, 'output', 'images'), args.output_name ?? defaultName(prompt), Buffer.from(b64, 'base64'))
    return JSON.stringify({ path, action, size: data.size ?? size, model: MODEL })
  },
}
