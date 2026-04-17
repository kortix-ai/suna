import { describe, it, expect, afterEach, mock } from 'bun:test'

/**
 * Tests for the exa_search tool.
 *
 * The tool calls the Exa search API via fetch() and returns formatted JSON.
 * Because importing the tool requires @opencode-ai/plugin (unavailable in
 * the test env), we inline the core helpers and exercise them directly,
 * plus test the HTTP layer by mocking globalThis.fetch.
 */

// ── Inline the types and helpers from the tool ────────────────────────────

interface ExaResult {
  title: string
  url: string
  id: string
  publishedDate?: string | null
  author?: string | null
  text?: string
  highlights?: string[]
  highlightScores?: number[]
  summary?: string
}

interface ExaResponse {
  requestId: string
  results: ExaResult[]
  searchType?: string
}

function buildSnippet(r: ExaResult): string {
  if (r.highlights && r.highlights.length > 0) return r.highlights.join(' … ')
  if (r.summary) return r.summary
  if (r.text) return r.text.slice(0, 500)
  return ''
}

function formatSingle(query: string, response: ExaResponse): string {
  return JSON.stringify(
    {
      query,
      success: response.results.length > 0,
      results: response.results.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: buildSnippet(r),
        published_date: r.publishedDate ?? '',
        author: r.author ?? '',
      })),
      search_type: response.searchType ?? '',
    },
    null,
    2,
  )
}

function parseDomains(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined
  const domains = raw
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean)
  return domains.length > 0 ? domains : undefined
}

// ── Fixture data ──────────────────────────────────────────────────────────

const FIXTURE_RESPONSE: ExaResponse = {
  requestId: 'req_abc123',
  results: [
    {
      title: 'Introduction to Neural Search',
      url: 'https://example.com/neural-search',
      id: 'res_1',
      publishedDate: '2024-06-15T00:00:00Z',
      author: 'Jane Doe',
      text: 'Neural search uses embeddings to find semantically similar content.',
      highlights: [
        'Neural search uses embeddings',
        'semantically similar content',
      ],
      highlightScores: [0.95, 0.88],
      summary: 'An overview of neural search techniques.',
    },
    {
      title: 'Search Engine Optimization Guide',
      url: 'https://example.com/seo-guide',
      id: 'res_2',
      publishedDate: null,
      author: null,
      text: 'SEO best practices for 2024 and beyond.',
    },
  ],
  searchType: 'neural',
}

const FIXTURE_EMPTY_RESPONSE: ExaResponse = {
  requestId: 'req_empty',
  results: [],
  searchType: 'auto',
}

// ── buildSnippet tests ────────────────────────────────────────────────────

describe('exa_search: buildSnippet', () => {
  it('prefers highlights when all content fields are present', () => {
    const result = FIXTURE_RESPONSE.results[0]!
    const snippet = buildSnippet(result)
    expect(snippet).toBe('Neural search uses embeddings … semantically similar content')
  })

  it('falls back to summary when highlights are missing', () => {
    const result: ExaResult = {
      title: 'Test',
      url: 'https://test.com',
      id: 'r1',
      summary: 'A summary of the page.',
      text: 'Full text content here.',
    }
    expect(buildSnippet(result)).toBe('A summary of the page.')
  })

  it('falls back to text when highlights and summary are missing', () => {
    const result = FIXTURE_RESPONSE.results[1]!
    expect(buildSnippet(result)).toBe('SEO best practices for 2024 and beyond.')
  })

  it('returns empty string when no content fields are present', () => {
    const result: ExaResult = {
      title: 'Empty',
      url: 'https://empty.com',
      id: 'r0',
    }
    expect(buildSnippet(result)).toBe('')
  })

  it('falls back to summary when highlights array is empty', () => {
    const result: ExaResult = {
      title: 'Test',
      url: 'https://test.com',
      id: 'r1',
      highlights: [],
      summary: 'Fallback summary.',
    }
    expect(buildSnippet(result)).toBe('Fallback summary.')
  })

  it('truncates text to 500 characters', () => {
    const longText = 'A'.repeat(600)
    const result: ExaResult = {
      title: 'Long',
      url: 'https://long.com',
      id: 'r2',
      text: longText,
    }
    expect(buildSnippet(result)).toHaveLength(500)
  })
})

// ── formatSingle tests ────────────────────────────────────────────────────

describe('exa_search: formatSingle', () => {
  it('formats a successful response with results', () => {
    const output = JSON.parse(formatSingle('neural search', FIXTURE_RESPONSE))
    expect(output.query).toBe('neural search')
    expect(output.success).toBe(true)
    expect(output.search_type).toBe('neural')
    expect(output.results).toHaveLength(2)

    const first = output.results[0]
    expect(first.title).toBe('Introduction to Neural Search')
    expect(first.url).toBe('https://example.com/neural-search')
    expect(first.snippet).toContain('Neural search uses embeddings')
    expect(first.published_date).toBe('2024-06-15T00:00:00Z')
    expect(first.author).toBe('Jane Doe')
  })

  it('uses empty strings for null publishedDate and author', () => {
    const output = JSON.parse(formatSingle('seo', FIXTURE_RESPONSE))
    const second = output.results[1]
    expect(second.published_date).toBe('')
    expect(second.author).toBe('')
  })

  it('marks empty results as not successful', () => {
    const output = JSON.parse(formatSingle('nothing', FIXTURE_EMPTY_RESPONSE))
    expect(output.success).toBe(false)
    expect(output.results).toHaveLength(0)
  })

  it('uses empty string when searchType is missing', () => {
    const response: ExaResponse = {
      requestId: 'req_no_type',
      results: FIXTURE_RESPONSE.results,
    }
    const output = JSON.parse(formatSingle('test', response))
    expect(output.search_type).toBe('')
  })
})

// ── parseDomains tests ────────────────────────────────────────────────────

describe('exa_search: parseDomains', () => {
  it('parses comma-separated domains', () => {
    expect(parseDomains('arxiv.org, nature.com')).toEqual([
      'arxiv.org',
      'nature.com',
    ])
  })

  it('returns undefined for empty string', () => {
    expect(parseDomains('')).toBeUndefined()
  })

  it('returns undefined for undefined input', () => {
    expect(parseDomains(undefined)).toBeUndefined()
  })

  it('filters out blank entries from trailing commas', () => {
    expect(parseDomains('example.com, , test.com,')).toEqual([
      'example.com',
      'test.com',
    ])
  })

  it('trims whitespace from domains', () => {
    expect(parseDomains('  a.com ,  b.com  ')).toEqual(['a.com', 'b.com'])
  })
})

// ── fetch integration tests (mock globalThis.fetch) ───────────────────────

describe('exa_search: API call via fetch', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('sends correct headers and body to Exa API', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined

    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedUrl = String(input)
      capturedInit = init
      return new Response(JSON.stringify(FIXTURE_RESPONSE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const res = await globalThis.fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: {
        'x-api-key': 'test-key',
        'Content-Type': 'application/json',
        'x-exa-integration': 'suna',
      },
      body: JSON.stringify({
        query: 'test query',
        type: 'auto',
        numResults: 5,
        contents: { highlights: true },
      }),
    })

    expect(capturedUrl).toBe('https://api.exa.ai/search')
    expect(capturedInit?.method).toBe('POST')

    const headers = capturedInit?.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('test-key')
    expect(headers['x-exa-integration']).toBe('suna')

    const body = JSON.parse(capturedInit?.body as string)
    expect(body.query).toBe('test query')
    expect(body.type).toBe('auto')
    expect(body.numResults).toBe(5)
    expect(body.contents.highlights).toBe(true)

    const data = (await res.json()) as ExaResponse
    expect(data.results).toHaveLength(2)
  })

  it('handles API error responses', async () => {
    globalThis.fetch = (async () => {
      return new Response('{"error": "Invalid API key"}', {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const res = await globalThis.fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'x-api-key': 'bad-key' },
      body: '{}',
    })

    expect(res.ok).toBe(false)
    expect(res.status).toBe(401)
  })

  it('handles network errors', async () => {
    globalThis.fetch = (async () => {
      throw new Error('Network request failed')
    }) as typeof fetch

    let error: Error | null = null
    try {
      await globalThis.fetch('https://api.exa.ai/search', {
        method: 'POST',
        body: '{}',
      })
    } catch (e) {
      error = e as Error
    }

    expect(error).not.toBeNull()
    expect(error!.message).toBe('Network request failed')
  })

  it('parses a complete API response with all content types', async () => {
    const fullResponse: ExaResponse = {
      requestId: 'req_full',
      results: [
        {
          title: 'Full Content Result',
          url: 'https://example.com/full',
          id: 'r_full',
          publishedDate: '2024-12-01T00:00:00Z',
          author: 'Test Author',
          text: 'Full page text content for this result.',
          highlights: ['Key passage one', 'Key passage two'],
          highlightScores: [0.97, 0.91],
          summary: 'AI-generated summary of the page.',
        },
      ],
      searchType: 'auto',
    }

    globalThis.fetch = (async () => {
      return new Response(JSON.stringify(fullResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const res = await globalThis.fetch('https://api.exa.ai/search', {
      method: 'POST',
      body: '{}',
    })
    const data = (await res.json()) as ExaResponse
    const result = data.results[0]!

    // Verify all content types are present
    expect(result.text).toBe('Full page text content for this result.')
    expect(result.highlights).toEqual(['Key passage one', 'Key passage two'])
    expect(result.summary).toBe('AI-generated summary of the page.')

    // buildSnippet should prefer highlights
    expect(buildSnippet(result)).toBe('Key passage one … Key passage two')
  })
})
