import { tool } from "@opencode-ai/plugin";
import { tavily } from "@tavily/core";
import { getEnv, getKortixRouterBase } from "./lib/get-env";
import { featureDisabled, disabledResult } from "./lib/runtime-gate";

interface SearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  publishedDate?: string;
  rawContent?: string;
}

interface SearchImage {
  url: string;
  description?: string;
}

interface SearchResponse {
  query: string;
  answer?: string;
  results: SearchResult[];
  images?: SearchImage[];
  responseTime?: number;
}

function formatSingle(query: string, response: SearchResponse): string {
  return JSON.stringify(
    {
      query,
      success: response.results.length > 0 || !!response.answer,
      answer: response.answer ?? "",
      results: response.results.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
        score: r.score,
        published_date: r.publishedDate ?? "",
      })),
      images: (response.images ?? []).map((img) => ({
        url: img.url,
        description: img.description ?? "",
      })),
      response_time_ms: response.responseTime,
    },
    null,
    2,
  );
}

export default tool({
  description:
    "Search the web for up-to-date information using Tavily. " +
    "Returns titles, URLs, snippets, relevance scores, images, and a synthesized AI answer. " +
    "Supports batch queries separated by |||. " +
    "Use topic='news' for current events, topic='finance' for financial data. " +
    "After using results, ALWAYS include a Sources section with markdown hyperlinks.",
  args: {
    query: tool.schema
      .string()
      .describe(
        "Search query. For batch, separate with ||| (e.g. 'query one ||| query two')",
      ),
    num_results: tool.schema
      .number()
      .optional()
      .describe("Results per query (1-20). Default: 5"),
    topic: tool.schema
      .string()
      .optional()
      .describe("Search topic: 'general' (default), 'news', or 'finance'"),
    search_depth: tool.schema
      .string()
      .optional()
      .describe(
        "Search depth: 'basic' (faster, cheaper, default) or 'advanced' (slower, more thorough). Use 'basic' for most queries. Reserve 'advanced' for deep research where comprehensiveness matters.",
      ),
  },
  async execute(args, _context) {
    if (featureDisabled("web_tools")) return disabledResult("web_tools", "web_search");
    // Route through the Kortix router (derived from KORTIX_API_URL) and auth with
    // KORTIX_TOKEN; the router injects the real upstream key. Fall back to a raw
    // TAVILY_API_KEY only when KORTIX_API_URL is unset (self-host/direct).
    const apiBaseURL = getKortixRouterBase("tavily") ?? undefined;
    const apiKey = apiBaseURL
      ? getEnv("KORTIX_TOKEN")
      : getEnv("TAVILY_API_KEY");
    if (!apiKey) return apiBaseURL
      ? "Error: KORTIX_TOKEN not set."
      : "Error: TAVILY_API_KEY not set.";

    const client = tavily({ apiKey, ...(apiBaseURL ? { apiBaseURL } : {}) });
    const maxResults = Math.max(1, Math.min(args.num_results ?? 5, 20));
    const topic = (args.topic as "general" | "news" | "finance") ?? "general";

    const queries = args.query
      .split("|||")
      .map((q) => q.trim())
      .filter(Boolean);
    if (queries.length === 0) return "Error: empty query.";

    const searchOne = async (
      q: string,
    ): Promise<{ query: string; data?: SearchResponse; error?: string }> => {
      try {
        const response = (await client.search(q, {
          searchDepth: (args.search_depth as "basic" | "advanced") || "basic",
          topic,
          maxResults,
          includeAnswer: true,
          includeImages: true,
          includeImageDescriptions: true,
        })) as unknown as SearchResponse;
        return { query: q, data: response };
      } catch (e) {
        return { query: q, error: String(e) };
      }
    };

    const results = await Promise.all(queries.map(searchOne));

    if (queries.length === 1) {
      const r = results[0]!;
      if (r.error)
        return JSON.stringify(
          { query: r.query, success: false, error: r.error },
          null,
          2,
        );
      return formatSingle(r.query, r.data!);
    }

    return JSON.stringify(
      {
        batch_mode: true,
        total_queries: queries.length,
        results: results.map((r) => {
          if (r.error)
            return { query: r.query, success: false, error: r.error };
          const d = r.data!;
          return {
            query: r.query,
            success: d.results.length > 0 || !!d.answer,
            answer: d.answer ?? "",
            results: d.results.map((res) => ({
              title: res.title,
              url: res.url,
              snippet: res.content,
              score: res.score,
              published_date: res.publishedDate ?? "",
            })),
            images: (d.images ?? []).map((img) => ({
              url: img.url,
              description: img.description ?? "",
            })),
          };
        }),
      },
      null,
      2,
    );
  },
});
