/**
 * scrape_webpage: the Kortix page scraper (Firecrawl). Kortix maintains this
 * file. A project lists it in kortix.yaml as
 * `scrape_webpage: kortix:scrape_webpage`. `kortix tools eject scrape_webpage`
 * copies it to `tools/scrape_webpage.ts` for the project to own and change;
 * the copy runs unchanged on every harness.
 *
 * A call goes to the Kortix API's billed router proxy with the session token
 * (`KORTIX_API_URL`, `KORTIX_TOKEN`); the router holds the Firecrawl key. A
 * box with no Kortix API calls Firecrawl itself with `FIRECRAWL_API_KEY`.
 *
 * The web UI renders a call from the output JSON. A changed copy must keep
 * that shape, or the UI shows the raw output.
 */

/** What a call receives (the project tool contract): the session env, secrets included, and the turn's abort signal. */
interface ToolContext {
  env: Record<string, string | undefined>
  signal?: AbortSignal
}

const TIMEOUT_MS = 35_000
const RETRIES = 3

/** The Kortix router proxy and the session token, or Firecrawl and the project's own key. */
function upstream(env: ToolContext['env']): { base: string; key: string } {
  const api = env.KORTIX_API_URL?.trim().replace(/\/+$/, '')
  if (api) {
    const token = env.KORTIX_TOKEN?.trim()
    if (!token) throw new Error('KORTIX_TOKEN is not set.')
    return { base: `${api.endsWith('/v1') ? api : `${api}/v1`}/router/firecrawl`, key: token }
  }
  const key = env.FIRECRAWL_API_KEY?.trim()
  if (!key) throw new Error('FIRECRAWL_API_KEY is not set.')
  return { base: 'https://api.firecrawl.dev', key }
}

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
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`${base}/v2/scrape`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, formats: includeHtml ? ['markdown', 'html'] : ['markdown'], timeout: 30000 }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
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
      const reason = err instanceof Error ? err.message : String(err)
      // Only a timeout is worth a second request; an aborted turn is not.
      if (/timeout/i.test(reason) && attempt < RETRIES && !signal?.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000))
        continue
      }
      return { url, success: false, error: reason }
    }
  }
}

export default {
  description:
    'Fetch and extract content from web pages using Firecrawl. ' +
    'Converts HTML to clean markdown. ' +
    'Supports multiple URLs separated by commas. ' +
    'Batch URLs in a single call for efficiency. ' +
    'For GitHub URLs, prefer gh CLI via Bash instead.',
  parameters: {
    type: 'object',
    properties: {
      urls: { type: 'string', description: "URLs to scrape, comma-separated (e.g. 'https://example.com/a,https://example.com/b')" },
      include_html: { type: 'boolean', description: 'Include raw HTML alongside markdown. Default: false' },
    },
    required: ['urls'],
  },
  async execute(args: Record<string, any>, { env, signal }: ToolContext): Promise<string> {
    const { base, key } = upstream(env)
    const urls = String(args.urls ?? '').split(',').map((url) => url.trim()).filter(Boolean)
    if (urls.length === 0) throw new Error('No valid URLs provided.')
    const results = await Promise.all(urls.map((url) => scrapeOne(base, key, url, args.include_html ?? false, signal)))
    const successful = results.filter((result) => result.success).length
    if (successful === 0) {
      throw new Error(`Failed to scrape all ${results.length} URLs. ${results.map((r) => `${r.url}: ${r.error}`).join('; ')}`)
    }
    if (results.length === 1) return JSON.stringify(results[0], null, 2)
    return JSON.stringify({ total: results.length, successful, failed: results.length - successful, results }, null, 2)
  },
}
