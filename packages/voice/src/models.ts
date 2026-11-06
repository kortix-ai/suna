// Where the voice's own model calls go. Unset (a local run): each vendor's API with its key, exactly as before. In a
// Kortix box, VOICE_MODELS_URL names one OpenAI-compatible base (the box's model proxy, which adds the box's own token)
// that serves every one of them by name: the fast chat models, Whisper, the voice and the screen reader, as Platinum's
// private models through Kortix's gateway. Their ids there are the vendor's without its org prefix
// ("qwen/qwen3.8-27b" is "qwen3.8-27b"). VOICE_MODELS_TOKEN: a bearer, when the base does not add one itself.
const GROQ = 'https://api.groq.com/openai/v1'
// Read per call: a host sets it when it binds (src/kortix.ts), whatever imported this first.
const base = () => process.env.VOICE_MODELS_URL?.replace(/\/+$/, '') || undefined

/** True when the calls go to VOICE_MODELS_URL (a Kortix box), not the vendors. */
export const viaModels = (): boolean => base() !== undefined

/** The fast models are at hand: Groq's own key (a local run), or the models base, which serves the same ids. Every
 * fast step (the lane, the router, end of turn, the room judge, a watch's check, ...) asks this, never the key alone:
 * a Kortix box has no Groq key. */
export const fastOn = (): boolean => viaModels() || !!process.env.GROQ_API_KEY

/** A model's id where the call goes: the vendor's own, or the models base's (no org prefix). */
export const modelId = (id: string): string => (base() ? id.replace(/^[^/]+\//, '') : id)

/** The request's headers for the models base: its bearer (or none), never a vendor key. */
function baseHeaders(headers: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries((headers ?? {}) as Record<string, string>)) if (k.toLowerCase() !== 'authorization') out[k] = v
  if (process.env.VOICE_MODELS_TOKEN) out.Authorization = `Bearer ${process.env.VOICE_MODELS_TOKEN}`
  return out
}

/** A fast chat call: fetch(Groq's chat completions, init) locally; the models base, its model renamed, in a box. */
export function fastFetch(init: RequestInit): Promise<Response> {
  const BASE = base()
  if (!BASE) return fetch(`${GROQ}/chat/completions`, init)
  let body = init.body
  if (typeof body === 'string') {
    const j = JSON.parse(body) as { model?: unknown }
    if (typeof j.model === 'string') body = JSON.stringify({ ...j, model: modelId(j.model) })
  }
  //codeql[js/file-access-to-http] Non-exploit, by design: forwards the call's chat request to the models base from the session's own configuration (the models base/prompts env), never caller-chosen; the body is the call's own prompt.
  return fetch(`${BASE}/chat/completions`, { ...init, headers: baseHeaders(init.headers), body })
}

/** A Whisper call: Groq's transcriptions locally; the models base in a box (the form's model id is the same there). */
export function sttFetch(init: RequestInit): Promise<Response> {
  const BASE = base()
  if (!BASE) return fetch(`${GROQ}/audio/transcriptions`, init)
  return fetch(`${BASE}/audio/transcriptions`, { ...init, headers: baseHeaders(init.headers) })
}

// The searches (src/prefetch.ts, src/pages.ts) in a Kortix box: the Kortix API's billed router with the session's token,
// as kortixd's own web_search does (the router holds the providers' keys); undefined elsewhere (each provider's key).
export const router = ((api = process.env.KORTIX_API_URL?.trim().replace(/\/+$/, ''), token = process.env.KORTIX_TOKEN?.trim()) =>
  api && token ? { base: `${api.endsWith('/v1') ? api : `${api}/v1`}/router`, token } : undefined)
/** A search provider's endpoint through the router, or undefined outside a Kortix box. */
export const routed = (service: string, path: string) => ((r = router()) => r && { url: `${r.base}/${service}${path}`, headers: { Authorization: `Bearer ${r.token}` } })()

/** The models base's speech and voices endpoints (OpenAI-shaped speech, streamed PCM), for the `models` voice. */
export const speechUrl = (): string => `${base()}/audio/speech`
// The gateway finds the voices' upstream from a speech model's id.
export const voicesUrl = (): string => `${base()}/audio/voices?model=${encodeURIComponent(process.env.INWORLD_MODEL ?? 'inworld-tts-2')}`
export const modelsHeaders = (): Record<string, string> => baseHeaders({})
