/**
 * The three web tools a Kortix session has on every harness: `web_search`
 * (Tavily), `image_search` (Serper) and `scrape_webpage` (Firecrawl). Names,
 * arguments and output JSON equal the project template's OpenCode tools, so a
 * skill that names them and the client's tool views work on pi unchanged.
 *
 * Each call goes to the API's billed router proxy with the sandbox token; the
 * router holds the upstream key. A box with no control plane calls the
 * upstream itself with the project's own key.
 */
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'
import { readControlPlaneEnv } from '@/lib/kortix-api/relay-context'

const SEARCH_TIMEOUT_MS = 60_000
const SCRAPE_TIMEOUT_MS = 35_000

const text = (value: string): AgentToolResult<undefined> => ({ content: [{ type: 'text', text: value }], details: undefined })
const json = (value: unknown) => text(JSON.stringify(value, null, 2))
const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

function upstream(service: string, direct: string, keyName: string): { base: string; key: string } {
  const { apiRoot, token } = readControlPlaneEnv()
  if (apiRoot) {
    if (!token) throw new Error('KORTIX_TOKEN is not set.')
    return { base: `${apiRoot}/router/${service}`, key: token }
  }
  const key = process.env[keyName]?.trim()
  if (!key) throw new Error(`${keyName} is not set.`)
  return { base: direct, key }
}

function split(value: string, separator: string, empty: string): string[] {
  const parts = value.split(separator).map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) throw new Error(empty)
  return parts
}

const within = (ms: number, signal?: AbortSignal) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms))

const webSearchSchema = Type.Object({
  query: Type.String({ description: "Search query. For batch, separate with ||| (e.g. 'query one ||| query two')" }),
  num_results: Type.Optional(Type.Number({ description: 'Results per query (1-20). Default: 5' })),
  topic: Type.Optional(Type.String({ description: "Search topic: 'general' (default), 'news', or 'finance'" })),
  search_depth: Type.Optional(
    Type.String({
      description:
        "Search depth: 'basic' (faster, cheaper, default) or 'advanced' (slower, more thorough). Use 'basic' for most queries. Reserve 'advanced' for deep research where comprehensiveness matters.",
    }),
  ),
})

type TavilyResponse = {
  answer?: string
  results?: Array<{ title?: string; url?: string; content?: string; score?: number; published_date?: string }>
  images?: Array<string | { url?: string; description?: string }>
  response_time?: number
}

export function createWebSearchTool(): AgentTool<typeof webSearchSchema, undefined> {
  return {
    name: 'web_search',
    label: 'web_search',
    description:
      'Search the web for up-to-date information using Tavily. ' +
      'Returns titles, URLs, snippets, relevance scores, images, and a synthesized AI answer. ' +
      'Supports batch queries separated by |||. ' +
      "Use topic='news' for current events, topic='finance' for financial data. " +
      'After using results, ALWAYS include a Sources section with markdown hyperlinks.',
    parameters: webSearchSchema,
    async execute(_id, args, signal) {
      const { base, key } = upstream('tavily', 'https://api.tavily.com', 'TAVILY_API_KEY')
      const queries = split(args.query, '|||', 'The query is empty.')
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
            signal: within(SEARCH_TIMEOUT_MS, signal),
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
      if (results.length === 1) return json(results[0])
      return json({ batch_mode: true, total_queries: queries.length, results })
    },
  }
}

const imageSearchSchema = Type.Object({
  query: Type.String({ description: "Image search query. For batch, separate with ||| (e.g. 'cats ||| dogs')" }),
  num_results: Type.Optional(Type.Number({ description: 'Images per query (1-100). Default: 12' })),
})

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

export function createImageSearchTool(): AgentTool<typeof imageSearchSchema, undefined> {
  return {
    name: 'image_search',
    label: 'image_search',
    description:
      'Search for images using the Serper Google Images API. ' +
      'Returns image URLs with titles, source pages, and dimensions. ' +
      'Supports batch queries separated by |||. ' +
      'Use specific descriptive queries including topic/brand names for best results.',
    parameters: imageSearchSchema,
    async execute(_id, args, signal) {
      const { base, key } = upstream('serper', 'https://google.serper.dev', 'SERPER_API_KEY')
      const queries = split(args.query, '|||', 'The query is empty.')
      const num = Math.max(1, Math.min(args.num_results ?? 12, 100))
      const payload = queries.map((q) => ({ q, num }))
      const response = await fetch(`${base}/images`, {
        method: 'POST',
        headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload.length === 1 ? payload[0] : payload),
        signal: within(SEARCH_TIMEOUT_MS, signal),
      })
      if (!response.ok) throw new Error(`Serper API returned ${response.status}: ${await response.text()}`)
      const data = (await response.json()) as SerperResponse | SerperResponse[]
      if (queries.length > 1) {
        const all = Array.isArray(data) ? data : [data]
        return json({ batch_mode: true, results: all.map((entry, i) => serperImages(queries[i]!, entry)) })
      }
      const single = serperImages(queries[0]!, Array.isArray(data) ? (data[0] ?? {}) : data)
      return single.total === 0 ? text(`No images found for: '${queries[0]}'`) : json(single)
    },
  }
}

const scrapeSchema = Type.Object({
  urls: Type.String({ description: "URLs to scrape, comma-separated (e.g. 'https://example.com/a,https://example.com/b')" }),
  include_html: Type.Optional(Type.Boolean({ description: 'Include raw HTML alongside markdown. Default: false' })),
})

type ScrapeResult = {
  url: string
  success: boolean
  title?: string
  content?: string
  content_length?: number
  html?: string
  metadata?: Record<string, unknown>
  error?: string
}

async function scrapeOne(base: string, key: string, url: string, includeHtml: boolean, signal?: AbortSignal): Promise<ScrapeResult> {
  const retries = 3
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`${base}/v2/scrape`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, formats: includeHtml ? ['markdown', 'html'] : ['markdown'], timeout: 30000 }),
        signal: within(SCRAPE_TIMEOUT_MS, signal),
      })
      const raw = await response.text()
      const body = JSON.parse(raw) as { success?: boolean; data?: Record<string, unknown>; error?: string }
      if (!response.ok || !body.success) throw new Error(body.error || `${response.status} Error: ${raw}`)
      const data = body.data ?? {}
      const metadata = (data.metadata ?? {}) as Record<string, string>
      const markdown = (data.markdown ?? '') as string
      const html = (data.html ?? '') as string
      return {
        url,
        success: true,
        title: metadata.title ?? '',
        content: markdown,
        content_length: markdown.length,
        ...(includeHtml && html ? { html } : {}),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      }
    } catch (err) {
      const reason = message(err)
      // Only a timeout is worth a second request; an aborted turn is not.
      if (/timeout/i.test(reason) && attempt < retries && !signal?.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000))
        continue
      }
      return { url, success: false, error: reason }
    }
  }
}

export function createScrapeWebpageTool(): AgentTool<typeof scrapeSchema, undefined> {
  return {
    name: 'scrape_webpage',
    label: 'scrape_webpage',
    description:
      'Fetch and extract content from web pages using Firecrawl. ' +
      'Converts HTML to clean markdown. ' +
      'Supports multiple URLs separated by commas. ' +
      'Batch URLs in a single call for efficiency. ' +
      'For GitHub URLs, prefer gh CLI via Bash instead.',
    parameters: scrapeSchema,
    async execute(_id, args, signal) {
      const { base, key } = upstream('firecrawl', 'https://api.firecrawl.dev', 'FIRECRAWL_API_KEY')
      const urls = split(args.urls, ',', 'No valid URLs provided.')
      const results = await Promise.all(urls.map((url) => scrapeOne(base, key, url, args.include_html ?? false, signal)))
      const successful = results.filter((result) => result.success).length
      if (successful === 0) {
        throw new Error(`Failed to scrape all ${results.length} URLs. ${results.map((r) => `${r.url}: ${r.error}`).join('; ')}`)
      }
      if (results.length === 1) return json(results[0])
      return json({ total: results.length, successful, failed: results.length - successful, results })
    },
  }
}
