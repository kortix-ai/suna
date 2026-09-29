import { tool } from "./lib/tool";
import { getEnv, getKortixRouterBase } from "./lib/get-env";

const TAVILY_DEFAULT_URL = "https://api.tavily.com";
const SEARCH_TIMEOUT_MS = 60_000;

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

interface TavilyApiResponse {
  answer?: string;
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    score?: number;
    published_date?: string;
    raw_content?: string;
  }>;
  images?: Array<string | { url?: string; description?: string }>;
  response_time?: number;
}

async function search(
  apiBaseURL: string,
  apiKey: string,
  query: string,
  options: {
    searchDepth: "basic" | "advanced";
    topic: "general" | "news" | "finance";
    maxResults: number;
  },
): Promise<SearchResponse> {
  const response = await fetch(`${apiBaseURL.replace(/\/+$/, "")}/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      search_depth: options.searchDepth,
      topic: options.topic,
      max_results: options.maxResults,
      include_answer: true,
      include_images: true,
      include_image_descriptions: true,
    }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} Error: ${bodyText}`);
  }

  const data = JSON.parse(bodyText) as TavilyApiResponse;
  return {
    query,
    answer: data.answer,
    results: (data.results ?? []).map((result) => ({
      title: result.title ?? "",
      url: result.url ?? "",
      content: result.content ?? "",
      score: result.score ?? 0,
      publishedDate: result.published_date,
      rawContent: result.raw_content,
    })),
    images: (data.images ?? []).map((image) =>
      typeof image === "string"
        ? { url: image }
        : { url: image.url ?? "", description: image.description },
    ),
    responseTime: data.response_time,
  };
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
    // Route through the Kortix router (derived from KORTIX_API_URL) and auth with
    // KORTIX_SANDBOX_TOKEN (KORTIX_TOKEN kept as a legacy fallback); the router
    // injects the real upstream key. Fall back to a raw TAVILY_API_KEY only when
    // KORTIX_API_URL is unset (self-host/direct).
    const apiBaseURL = getKortixRouterBase("tavily") ?? TAVILY_DEFAULT_URL;
    const usesKortixRouter = getKortixRouterBase("tavily") !== null;
    const apiKey = usesKortixRouter
      ? getEnv("KORTIX_SANDBOX_TOKEN") || getEnv("KORTIX_TOKEN")
      : getEnv("TAVILY_API_KEY");
    if (!apiKey) return usesKortixRouter
      ? "Error: KORTIX_SANDBOX_TOKEN not set."
      : "Error: TAVILY_API_KEY not set.";

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
        const response = await search(apiBaseURL, apiKey, q, {
          searchDepth: (args.search_depth as "basic" | "advanced") || "basic",
          topic,
          maxResults,
        });
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
