/**
 * image_search: the Kortix image search tool (Serper Google Images). Kortix
 * maintains this file. A project lists it in kortix.yaml as
 * `image_search: kortix:image_search`. `kortix tools eject image_search`
 * copies it to `tools/image_search.ts` for the project to own and change; the
 * copy runs unchanged on every harness.
 *
 * A call goes to the Kortix API's billed router proxy with the session token
 * (`KORTIX_API_URL`, `KORTIX_TOKEN`); the router holds the Serper key. A box
 * with no Kortix API calls Serper itself with `SERPER_API_KEY`.
 *
 * The web UI renders a call from the output JSON. A changed copy must keep
 * that shape, or the UI shows the raw output.
 */

/** What a call receives (the project tool contract): the session env, secrets included, and the turn's abort signal. */
interface ToolContext {
  env: Record<string, string | undefined>
  signal?: AbortSignal
}

const TIMEOUT_MS = 60_000

/** The Kortix router proxy and the session token, or Serper and the project's own key. */
function upstream(env: ToolContext['env']): { base: string; key: string } {
  const api = env.KORTIX_API_URL?.trim().replace(/\/+$/, '')
  if (api) {
    const token = env.KORTIX_TOKEN?.trim()
    if (!token) throw new Error('KORTIX_TOKEN is not set.')
    return { base: `${api.endsWith('/v1') ? api : `${api}/v1`}/router/serper`, key: token }
  }
  const key = env.SERPER_API_KEY?.trim()
  if (!key) throw new Error('SERPER_API_KEY is not set.')
  return { base: 'https://google.serper.dev', key }
}

type SerperResponse = { images?: Array<{ imageUrl: string; title?: string; link?: string; imageWidth?: number; imageHeight?: number }> }

function serperImages(query: string, data: SerperResponse) {
  const images = (data.images ?? []).map((image) => ({
    url: image.imageUrl,
    title: image.title ?? '',
    source: image.link ?? '',
    width: image.imageWidth ?? 0,
    height: image.imageHeight ?? 0,
  }))
  return { query, total: images.length, images }
}

export default {
  description:
    'Search for images using the Serper Google Images API. ' +
    'Returns image URLs with titles, source pages, and dimensions. ' +
    'Supports batch queries separated by |||. ' +
    'Use specific descriptive queries including topic/brand names for best results.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: "Image search query. For batch, separate with ||| (e.g. 'cats ||| dogs')" },
      num_results: { type: 'number', description: 'Images per query (1-100). Default: 12' },
    },
    required: ['query'],
  },
  async execute(args: Record<string, any>, { env, signal }: ToolContext): Promise<string> {
    const { base, key } = upstream(env)
    const queries = String(args.query ?? '').split('|||').map((query) => query.trim()).filter(Boolean)
    if (queries.length === 0) throw new Error('The query is empty.')
    const num = Math.max(1, Math.min(args.num_results ?? 12, 100))
    const payload = queries.map((q) => ({ q, num }))
    const response = await fetch(`${base}/images`, {
      method: 'POST',
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload.length === 1 ? payload[0] : payload),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`Serper API returned ${response.status}: ${await response.text()}`)
    const data = (await response.json()) as SerperResponse | SerperResponse[]
    if (queries.length > 1) {
      const all = Array.isArray(data) ? data : [data]
      return JSON.stringify({ batch_mode: true, results: all.map((entry, i) => serperImages(queries[i]!, entry)) }, null, 2)
    }
    const single = serperImages(queries[0]!, Array.isArray(data) ? (data[0] ?? {}) : data)
    return single.total === 0 ? `No images found for: '${queries[0]}'` : JSON.stringify(single, null, 2)
  },
}
