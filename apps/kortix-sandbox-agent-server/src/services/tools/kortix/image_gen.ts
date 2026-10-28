/**
 * image_gen: the Kortix image generation tool, for any image model the
 * project can use (gpt-image-2 on a ChatGPT plan, OpenAI, Google, xAI or
 * OpenRouter image models with a key, Kortix-managed image models). Kortix
 * maintains this file. A project lists it in kortix.yaml as
 * `image_gen: kortix:image_gen`; a `tools:` list that does not name it still
 * loads it (DEFAULT_ON_KORTIX_TOOLS). `kortix tools eject image_gen` copies it
 * to `tools/image_gen.ts` for the project to own.
 *
 * A call takes one to four prompts and sends one request per prompt to the
 * Kortix LLM gateway (`KORTIX_LLM_BASE_URL`), all at once, with the session
 * token (`KORTIX_TOKEN`); the platform picks the model (`auto`, or the one
 * asked for) and resolves its credential, so the box never holds it. Each
 * image is saved under `<checkout>/output/images/<slug of its prompt>-<time>`
 * with the extension its bytes prove (png, jpg, webp), and the output is
 * `{ action, model, provider, images: [{ path, size, prompt }], failed?: [{ prompt, error }] }`:
 * never image bytes. `size` is read from the saved image's header; `model`
 * and `provider` are what answered the first saved image. A prompt that
 * fails is in `failed`; when every prompt fails the call throws the first
 * failure.
 *
 * Untrusted text can ask the model to misuse this tool, so the limits are
 * code: an image cap per turn and per session (a batch that would pass one
 * is refused whole, before any request), reference images only from inside
 * the checkout and only real images, file names that never leave
 * output/images and never overwrite. The turn cap keys on the turn's
 * id (`context.turnId`) when the harness names it, so direct, parallel,
 * script, retried and subagent calls of one turn share it; without one it
 * keys on the call's abort signal. The session cap bounds them all. The caps
 * count before the first await, so calls that run in parallel never pass a
 * cap together.
 *
 * The web UI renders a call from the output JSON. A changed copy must keep
 * that shape, or the UI shows the raw output.
 */
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'

/** What a call receives (the project tool contract). `turnId`, when the harness names it, is one per turn; `signal` may be one per call. */
interface ToolContext {
  sessionId: string
  directory: string
  env: Record<string, string | undefined>
  signal: AbortSignal
  turnId?: string
}

export const IMAGE_GEN_TURN_LIMIT = 10
export const IMAGE_GEN_SESSION_LIMIT = 50
const ASPECT_RATIOS = ['auto', '1:1', '3:2', '2:3', '16:9', '9:16', '4:3', '3:4']
const QUALITIES = ['auto', 'low', 'medium', 'high']
const MAX_PROMPTS = 4
const MAX_REFERENCES = 5
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024
/** 5 × 20 MiB as base64 is over the gateway's 128 MiB body cap. */
const MAX_REFERENCE_TOTAL_BYTES = 50 * 1024 * 1024
const TIMEOUT_MS = 300_000
const IMAGE_EXTENSIONS: Record<string, 'png' | 'jpeg' | 'webp'> = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp' }

// Images per turn and per session, in this process. A turn is `turnId` when the harness names it
// (one entry per session: the turn it is in), else the call's abort signal.
const sessionTurns = new Map<string, { turnId: string; count: number }>()
const signalTurns = new WeakMap<AbortSignal, number>()
const sessionCalls = new Map<string, number>()

/** The image type its first bytes prove, or null. */
function imageType(bytes: Buffer): 'png' | 'jpeg' | 'webp' | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  return null
}

/** `WxH` from the image header (PNG IHDR, JPEG SOF0/SOF2, WebP VP8/VP8L/VP8X), or null. */
function headerSize(bytes: Buffer, type: 'png' | 'jpeg' | 'webp'): string | null {
  try {
    if (type === 'png') return bytes.toString('latin1', 12, 16) === 'IHDR' ? `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}` : null
    if (type === 'webp') {
      const chunk = bytes.toString('latin1', 12, 16)
      if (chunk === 'VP8 ') return `${bytes.readUInt16LE(26) & 0x3fff}x${bytes.readUInt16LE(28) & 0x3fff}`
      if (chunk === 'VP8L') return `${(bytes.readUInt32LE(21) & 0x3fff) + 1}x${((bytes.readUInt32LE(21) >>> 14) & 0x3fff) + 1}`
      if (chunk === 'VP8X') return `${bytes.readUIntLE(24, 3) + 1}x${bytes.readUIntLE(27, 3) + 1}`
      return null
    }
    // JPEG: walk the segments after SOI to the frame header.
    for (let i = 2; bytes[i] === 0xff; i += 2 + bytes.readUInt16BE(i + 2)) {
      if (bytes[i + 1] === 0xc0 || bytes[i + 1] === 0xc2) return `${bytes.readUInt16BE(i + 7)}x${bytes.readUInt16BE(i + 5)}`
    }
    return null
  } catch {
    return null // a header cut short
  }
}

/** A reference image: a png/jpeg/webp file inside the checkout (symlinks followed), at most 20 MiB. */
function reference(path: string, root: string): { path: string; real: string; size: number; type: 'png' | 'jpeg' | 'webp' } {
  let real: string
  try {
    real = realpathSync(resolve(root, path))
  } catch {
    throw new Error(`Reference image not found: ${path}`)
  }
  if (!real.startsWith(`${realpathSync(root)}${sep}`)) throw new Error(`Reference image ${path} is outside the workspace.`)
  const type = IMAGE_EXTENSIONS[extname(real).toLowerCase()]
  if (!type) throw new Error(`Reference image ${path} is not a png, jpg, jpeg or webp file.`)
  const size = statSync(real).size
  if (size > MAX_REFERENCE_BYTES) throw new Error(`Reference image ${path} is larger than 20 MiB.`)
  return { path, real, size, type }
}

/** The reference as a data URL, when its first bytes prove its extension. */
function referenceUrl({ path, real, type }: ReturnType<typeof reference>): string {
  const bytes = readFileSync(real)
  if (imageType(bytes) !== type) throw new Error(`Reference image ${path} is not a ${type} image.`)
  return `data:image/${type};base64,${bytes.toString('base64')}`
}

/** `<checkout>/output/images`, created, or a refusal when its real path leaves the checkout (a symlinked `output/`). */
function outputDir(root: string): string {
  const dir = join(root, 'output', 'images')
  mkdirSync(dir, { recursive: true })
  if (!realpathSync(dir).startsWith(`${realpathSync(root)}${sep}`)) throw new Error('output/images is outside the workspace.')
  return dir
}

/** `<slug of the prompt>-<yyyymmdd-hhmmss>` */
function defaultName(prompt: string): string {
  const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-+|-+$/g, '') || 'image'
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  return `${slug}-${stamp}`
}

/** Write to `dir/base.ext`, or `base-2.ext`, `base-3.ext`…: an existing file is never replaced. */
function writeNew(dir: string, base: string, ext: string, bytes: Buffer): string {
  for (let n = 1; ; n++) {
    const path = join(dir, n === 1 ? `${base}.${ext}` : `${base}-${n}.${ext}`)
    try {
      writeFileSync(path, bytes, { flag: 'wx' })
      return path
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
}

/**
 * The gateway's refusal: `{ message, code, suggestion, provider }` or `{ error: { message, code, provider } }`.
 * The text ends with the stable code in brackets (`[provider_not_connected]`): clients key on it, not on the prose.
 * When the gateway names the provider that failed, `[provider:<id>]` comes right before the code
 * (`… [provider:openai] [provider_reauth_required]`), so the code stays the last token (R11, R37).
 */
async function refusal(response: Response): Promise<Error> {
  const text = await response.text()
  type Envelope = { message?: string; code?: string; suggestion?: string; provider?: string }
  let body: Envelope & { error?: Envelope } = {}
  try {
    body = JSON.parse(text)
  } catch {}
  const code = body.code ?? body.error?.code
  const provider = body.provider || body.error?.provider
  const message = (body.message ?? body.error?.message ?? text).slice(0, 500)
  const retry = response.headers.get('retry-after')
  const detail = [message, body.suggestion?.slice(0, 500), retry ? `Retry after ${retry} s.` : '', provider ? `[provider:${provider}]` : '', code ? `[${code}]` : '']
    .filter(Boolean)
    .join(' ')
  return new Error(`Image generation failed (${response.status}): ${detail}`)
}

/** Count `count` images against the turn and session caps, or refuse the whole batch. Synchronous: no await between check and count. */
function admit({ sessionId, signal, turnId }: ToolContext, count: number): void {
  const current = turnId ? sessionTurns.get(sessionId) : undefined
  const turn = turnId ? (current?.turnId === turnId ? current.count : 0) : (signalTurns.get(signal) ?? 0)
  const session = sessionCalls.get(sessionId) ?? 0
  if (turn + count > IMAGE_GEN_TURN_LIMIT) throw new Error(`Image limit for this turn reached (${IMAGE_GEN_TURN_LIMIT} images; ${turn} used, ${count} asked).`)
  if (session + count > IMAGE_GEN_SESSION_LIMIT) throw new Error(`Image limit for this session reached (${IMAGE_GEN_SESSION_LIMIT} images; ${session} used, ${count} asked).`)
  if (turnId) sessionTurns.set(sessionId, { turnId, count: turn + count })
  else signalTurns.set(signal, turn + count)
  sessionCalls.set(sessionId, session + count)
}

/** One prompt: one gateway request (`n: 1`), its image saved under `dir`. */
async function generateOne(url: string, token: string, body: Record<string, unknown>, prompt: string, dir: string, signal: AbortSignal) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, prompt }),
    signal,
  })
  if (!response.ok) throw await refusal(response)
  const data = (await response.json()) as { model?: string; provider?: string; data?: Array<{ b64_json?: string }>; size?: string }
  const b64 = data.data?.[0]?.b64_json
  if (!b64) throw new Error('Image generation returned no image.')
  const bytes = Buffer.from(b64, 'base64')
  // The bytes, not the answer's mime_type, decide the type: a mislabelled image keeps its real extension, and anything else (an SVG) is never written.
  const type = imageType(bytes)
  if (!type) throw new Error('Image generation returned an image that is not png, jpeg or webp.')
  const path = writeNew(dir, defaultName(prompt), type === 'jpeg' ? 'jpg' : type, bytes)
  return { path, size: headerSize(bytes, type) ?? data.size, prompt, model: data.model, provider: data.provider }
}

export default {
  description:
    'Generate or edit one to four images with an image model this project can use, for example gpt-image-2 with a ChatGPT plan, Gemini image models with a Google key, or OpenRouter image models. Saves the images under /workspace/output/images/ and returns their paths.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['generate', 'edit'], description: '`generate` a new image, or `edit` the reference images.' },
      prompts: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: MAX_PROMPTS,
        description: 'One prompt per image, 1–4: what the image shows, or what to change. The images are generated at the same time.',
      },
      model: {
        type: 'string',
        description:
          "An image model id, for example openai/gpt-image-1, google/gemini-2.5-flash-image, codex/gpt-image-2 or openrouter/google/gemini-2.5-flash-image. Omit to use the project's default image model.",
      },
      reference_images: {
        type: 'array',
        items: { type: 'string' },
        description: 'For `edit`: 1–5 workspace paths of png, jpg, jpeg or webp images, each at most 20 MiB, 50 MiB in total. Every prompt uses them.',
      },
      aspect_ratio: { type: 'string', enum: ASPECT_RATIOS, description: 'Width to height. Default: auto.' },
      quality: { type: 'string', enum: QUALITIES, description: 'Default: auto.' },
      transparent_background: { type: 'boolean', description: 'Default: false.' },
    },
    required: ['action', 'prompts'],
  },
  async execute(args: Record<string, any>, context: ToolContext): Promise<string> {
    const action = args.action
    if (action !== 'generate' && action !== 'edit') throw new Error("'action' must be 'generate' or 'edit'.")
    const prompts: string[] = Array.isArray(args.prompts) ? args.prompts.map((prompt: unknown) => (typeof prompt === 'string' ? prompt.trim() : '')) : []
    if (prompts.length < 1 || prompts.length > MAX_PROMPTS || prompts.includes('')) throw new Error(`'prompts' must be a list of 1 to ${MAX_PROMPTS} non-empty strings.`)
    if (args.model != null && typeof args.model !== 'string') throw new Error("'model' must be a model id.")
    const model = args.model?.trim() || 'auto'
    const aspectRatio = args.aspect_ratio ?? 'auto'
    if (!ASPECT_RATIOS.includes(aspectRatio)) throw new Error(`'aspect_ratio' must be one of ${ASPECT_RATIOS.join(', ')}.`)
    const quality = args.quality ?? 'auto'
    if (!QUALITIES.includes(quality)) throw new Error(`'quality' must be one of ${QUALITIES.join(', ')}.`)
    const references: unknown[] = args.reference_images ?? []
    if (!Array.isArray(references)) throw new Error("'reference_images' must be a list of paths.")
    if (action === 'edit' && references.length === 0) throw new Error("'reference_images' is required for action 'edit'.")
    if (action === 'generate' && references.length > 0) throw new Error("'reference_images' is only used with action 'edit'.")
    if (references.length > MAX_REFERENCES) throw new Error(`At most ${MAX_REFERENCES} reference images.`)
    const checked = references.map((path) => reference(String(path), context.directory))
    if (checked.reduce((sum, ref) => sum + ref.size, 0) > MAX_REFERENCE_TOTAL_BYTES) throw new Error('Reference images are larger than 50 MiB in total.')
    const images = checked.map((ref) => ({ image_url: referenceUrl(ref) }))

    const base = context.env.KORTIX_LLM_BASE_URL?.trim().replace(/\/+$/, '')
    if (!base) throw new Error('KORTIX_LLM_BASE_URL is not set.')
    const token = context.env.KORTIX_TOKEN?.trim()
    if (!token) throw new Error('KORTIX_TOKEN is not set.')
    const dir = outputDir(context.directory)
    admit(context, prompts.length)

    const url = `${base}/images/${action === 'edit' ? 'edits' : 'generations'}`
    const body = { model, aspect_ratio: aspectRatio, quality, background: args.transparent_background === true ? 'transparent' : 'auto', n: 1, ...(images.length ? { images } : {}) }
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(TIMEOUT_MS)])
    const settled = await Promise.allSettled(prompts.map((prompt) => generateOne(url, token, body, prompt, dir, signal)))
    const saved = settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
    const failed = settled.flatMap((result, i) => (result.status === 'rejected' ? [{ prompt: prompts[i], error: result.reason instanceof Error ? result.reason.message : String(result.reason) }] : []))
    if (!saved.length) throw (settled[0] as PromiseRejectedResult).reason
    return JSON.stringify({
      action,
      model: saved[0]!.model,
      provider: saved[0]!.provider,
      images: saved.map(({ path, size, prompt }) => ({ path, size, prompt })),
      ...(failed.length ? { failed } : {}),
    })
  },
}
