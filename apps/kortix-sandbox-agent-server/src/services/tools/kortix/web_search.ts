/**
 * web_search: the Kortix web search tool (Tavily). Kortix maintains this file.
 * A project lists it in kortix.yaml as `web_search: kortix:web_search`.
 * `kortix tools eject web_search` copies it to `tools/web_search.ts` for the
 * project to own and change; the copy runs unchanged on every harness.
 *
 * A call goes to the Kortix API's billed router proxy with the session token
 * (`KORTIX_API_URL`, `KORTIX_TOKEN`); the router holds the Tavily key. A box
 * with no Kortix API calls Tavily itself with `TAVILY_API_KEY`.
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

/** The Kortix router proxy and the session token, or Tavily and the project's own key. */
function upstream(env: ToolContext['env']): { base: string; key: string } {
  const api = env.KORTIX_API_URL?.trim().replace(/\/+$/, '')
  if (api) {
    const token = env.KORTIX_TOKEN?.trim()
    if (!token) throw new Error('KORTIX_TOKEN is not set.')
    return { base: `${api.endsWith('/v1') ? api : `${api}/v1`}/router/tavily`, key: token }
  }
  const key = env.TAVILY_API_KEY?.trim()
  if (!key) throw new Error('TAVILY_API_KEY is not set.')
  return { base: 'https://api.tavily.com', key }
}

type TavilyResponse = {
  answer?: string
  results?: Array<{ title?: string; url?: string; content?: string; score?: number; published_date?: string }>
  images?: Array<string | { url?: string; description?: string }>
  response_time?: number
}

export default {
  description:
    'Search the web for up-to-date information using Tavily. ' +
    'Returns titles, URLs, snippets, relevance scores, images, and a synthesized AI answer. ' +
    'Supports batch queries separated by |||. ' +
    "Use topic='news' for current events, topic='finance' for financial data. " +
    'After using results, ALWAYS include a Sources section with markdown hyperlinks.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: "Search query. For batch, separate with ||| (e.g. 'query one ||| query two')" },
      num_results: { type: 'number', description: 'Results per query (1-20). Default: 5' },
      topic: { type: 'string', description: "Search topic: 'general' (default), 'news', or 'finance'" },
      search_depth: {
        type: 'string',
        description:
          "Search depth: 'basic' (faster, cheaper, default) or 'advanced' (slower, more thorough). Use 'basic' for most queries. Reserve 'advanced' for deep research where comprehensiveness matters.",
      },
    },
    required: ['query'],
  },
  async execute(args: Record<string, any>, { env, signal }: ToolContext): Promise<string> {
    const { base, key } = upstream(env)
    const queries = String(args.query ?? '').split('|||').map((query) => query.trim()).filter(Boolean)
    if (queries.length === 0) throw new Error('The query is empty.')
    const timeout = signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS)
    const searchOne = async (query: string) => {
      try {
        const response = await fetch(`${base}/search`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query,
            search_depth: args.search_depth || 'basic',
            topic: args.topic || 'general',
            max_results: Math.max(1, Math.min(args.num_results ?? 5, 20)),
            include_answer: true,
            include_images: true,
            include_image_descriptions: true,
          }),
          signal: timeout,
        })
        const body = await response.text()
        if (!response.ok) throw new Error(`${response.status} Error: ${body}`)
        const data = JSON.parse(body) as TavilyResponse
        const results = data.results ?? []
        return {
          query,
          success: results.length > 0 || !!data.answer,
          answer: data.answer ?? '',
          results: results.map((r) => ({
            title: r.title ?? '',
            url: r.url ?? '',
            snippet: r.content ?? '',
            score: r.score ?? 0,
            published_date: r.published_date ?? '',
          })),
          images: (data.images ?? []).map((image) =>
            typeof image === 'string' ? { url: image, description: '' } : { url: image.url ?? '', description: image.description ?? '' },
          ),
          response_time_ms: data.response_time,
        }
      } catch (err) {
        return { query, success: false, error: String(err) }
      }
    }
    const results = await Promise.all(queries.map(searchOne))
    if (results.length === 1) return JSON.stringify(results[0], null, 2)
    return JSON.stringify({ batch_mode: true, total_queries: queries.length, results }, null, 2)
  },
}
