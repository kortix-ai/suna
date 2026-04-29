/**
 * search_knowledge_base — search the user's Kortix knowledge base.
 *
 * Calls GET /v1/knowledge/search?q=<query> on the Kortix backend,
 * authenticated as the session user via KORTIX_TOKEN.
 *
 * Returns up to 5 notes with title, folder_path, and a 200-char snippet.
 */
import { tool } from "@opencode-ai/plugin"
import { getEnv } from "./lib/get-env"

interface KnowledgeResult {
  id: string
  title: string
  folder_path: string
  snippet: string
}

interface SearchResponse {
  results: KnowledgeResult[]
}

export default tool({
  description:
    "Search the user's personal knowledge base. Returns up to 5 matching notes with title, folder path, and a text snippet. Use this to recall stored information, project context, or personal notes the user has saved.",
  args: {
    query: tool.schema
      .string()
      .min(1)
      .max(500)
      .describe("Search query — keywords or a short phrase to find relevant notes"),
  },
  async execute(args: { query: string }): Promise<string> {
    const apiUrl = getEnv("KORTIX_API_URL") ?? getEnv("KORTIX_URL")
    if (!apiUrl) {
      return JSON.stringify({ error: "KORTIX_API_URL not configured", results: [] })
    }

    const token = getEnv("KORTIX_TOKEN")
    if (!token) {
      return JSON.stringify({ error: "KORTIX_TOKEN not configured", results: [] })
    }

    // Normalise: strip trailing /v1/router suffix if present
    const base = apiUrl.replace(/\/v1\/router\/?$/, "").replace(/\/+$/, "")

    try {
      const url = `${base}/v1/knowledge/search?q=${encodeURIComponent(args.query)}`
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(10_000),
      })

      if (!res.ok) {
        const text = await res.text().catch(() => "")
        return JSON.stringify({ error: `Backend returned ${res.status}: ${text}`, results: [] })
      }

      const data = (await res.json()) as SearchResponse

      return JSON.stringify({
        results: (data.results ?? []).slice(0, 5).map((r) => ({
          id: r.id,
          title: r.title,
          folder_path: r.folder_path,
          snippet: r.snippet,
        })),
      })
    } catch (err) {
      return JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
        results: [],
      })
    }
  },
})
