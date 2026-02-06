/**
 * Kortix OpenCode Plugin
 *
 * Provides web search and image search tools that call the Kortix backend API.
 * All billing is handled server-side.
 */

import { tool } from "@opencode-ai/plugin"

// Get Kortix API endpoint from environment
const KORTIX_API_URL = process.env.KORTIX_API_URL || "https://api.kortix.ai"
const KORTIX_TOKEN = process.env.KORTIX_TOKEN || ""

interface KortixApiResponse<T> {
  success: boolean
  data?: T
  error?: string
}

interface WebSearchResult {
  title: string
  url: string
  snippet: string
  published_date?: string
}

interface ImageSearchResult {
  title: string
  url: string
  thumbnail_url: string
  source_url: string
  width?: number
  height?: number
}

async function callKortixApi<T>(
  endpoint: string,
  body: Record<string, unknown>
): Promise<KortixApiResponse<T>> {
  try {
    const response = await fetch(`${KORTIX_API_URL}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${KORTIX_TOKEN}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const error = await response.text()
      return { success: false, error: `API error ${response.status}: ${error}` }
    }

    const data = await response.json()
    return { success: true, data }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

/**
 * Kortix Plugin - Main export
 *
 * This is the plugin function that OpenCode calls to register tools.
 */
export const KortixPlugin = async () => {
  return {
    name: "kortix",
    tool: {
      kortix_web_search: tool({
        description: `Search the web for current information on any topic. Use this when you need:
- Recent news or events
- Current facts or statistics
- Information that may have changed since your training data
- Real-time data like prices, weather, or stock information
- Research on specific topics

Returns relevant web pages with titles, URLs, and snippets.`,
        args: {
          query: tool.schema.string().describe("The search query to find relevant web pages"),
          max_results: tool.schema.number().optional().describe("Maximum number of results to return (default: 5, max: 10)"),
          search_depth: tool.schema.enum(["basic", "advanced"]).optional().describe("Search depth - 'basic' for quick results, 'advanced' for more thorough search"),
        },
        async execute(args: { query: string; max_results?: number; search_depth?: "basic" | "advanced" }, context: { sessionID?: string }) {
          const { query, max_results = 5, search_depth = "basic" } = args

          const result = await callKortixApi<{ results: WebSearchResult[] }>("/v1/kortix/web-search", {
            query,
            max_results: Math.min(max_results, 10),
            search_depth,
            session_id: context.sessionID,
          })

          if (!result.success || !result.data) {
            return `Web search failed: ${result.error || "Unknown error"}`
          }

          const { results } = result.data

          if (results.length === 0) {
            return `No results found for query: "${query}"`
          }

          const formatted = results.map((r, i) =>
            `[${i + 1}] ${r.title}\n    URL: ${r.url}\n    ${r.snippet}${r.published_date ? `\n    Published: ${r.published_date}` : ""}`
          ).join("\n\n")

          return `Web search results for "${query}":\n\n${formatted}`
        },
      }),

      kortix_image_search: tool({
        description: `Search for images on the web. Use this when you need to:
- Find reference images for a topic
- Get visual examples of concepts
- Find photos of people, places, or things
- Gather image resources for projects

Returns image URLs with thumbnails and source information.`,
        args: {
          query: tool.schema.string().describe("The search query to find relevant images"),
          max_results: tool.schema.number().optional().describe("Maximum number of images to return (default: 5, max: 20)"),
          safe_search: tool.schema.boolean().optional().describe("Enable safe search filtering (default: true)"),
        },
        async execute(args: { query: string; max_results?: number; safe_search?: boolean }, context: { sessionID?: string }) {
          const { query, max_results = 5, safe_search = true } = args

          const result = await callKortixApi<{ results: ImageSearchResult[] }>("/v1/kortix/image-search", {
            query,
            max_results: Math.min(max_results, 20),
            safe_search,
            session_id: context.sessionID,
          })

          if (!result.success || !result.data) {
            return `Image search failed: ${result.error || "Unknown error"}`
          }

          const { results } = result.data

          if (results.length === 0) {
            return `No images found for query: "${query}"`
          }

          const formatted = results.map((r, i) =>
            `[${i + 1}] ${r.title}\n    Image: ${r.url}\n    Source: ${r.source_url}${r.width && r.height ? `\n    Size: ${r.width}x${r.height}` : ""}`
          ).join("\n\n")

          return `Image search results for "${query}":\n\n${formatted}`
        },
      }),
    },
  }
}

export default KortixPlugin
