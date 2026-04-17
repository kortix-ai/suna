import { tool } from "@opencode-ai/plugin";
import { getEnv } from "./lib/get-env";

interface CrwSearchResult {
  url: string;
  title: string;
  description: string;
  position?: number;
  score?: number;
  publishedDate?: string;
}

interface CrwSearchResponse {
  success: boolean;
  data: CrwSearchResult[] | { web?: CrwSearchResult[]; news?: CrwSearchResult[] };
  error?: string;
}

interface AuthResult {
  apiUrl: string;
  apiKey: string;
  provider: "crw" | "tavily";
}

function isRouterProxy(url: string): boolean {
  return url.includes("/v1/router/");
}

function resolveAuth(): AuthResult | string {
  const crwUrl = getEnv("CRW_API_URL");
  const crwKey = getEnv("CRW_API_KEY");
  const kortixToken = getEnv("KORTIX_TOKEN");

  // Use CRW when we have a direct API key — always hit CRW directly,
  // never send a raw CRW key to the router proxy (it expects Kortix tokens).
  if (crwKey) {
    const directUrl = (crwUrl && !isRouterProxy(crwUrl)) ? crwUrl : "https://fastcrw.com/api";
    return {
      apiUrl: directUrl.replace(/\/+$/, ""),
      apiKey: crwKey,
      provider: "crw",
    };
  }

  // Use CRW via router proxy (URL injected by backend only when CRW is configured)
  if (crwUrl && isRouterProxy(crwUrl) && kortixToken) {
    return {
      apiUrl: crwUrl.replace(/\/+$/, ""),
      apiKey: kortixToken,
      provider: "crw",
    };
  }

  // Legacy Tavily proxy path
  const tavilyUrl = getEnv("TAVILY_API_URL");
  if (tavilyUrl) {
    const key = kortixToken || getEnv("TAVILY_API_KEY");
    if (!key) return "Error: KORTIX_TOKEN or TAVILY_API_KEY not set.";
    return {
      apiUrl: tavilyUrl.replace(/\/+$/, ""),
      apiKey: key,
      provider: "tavily",
    };
  }

  // Direct Tavily (no proxy, no CRW)
  const tavilyKey = getEnv("TAVILY_API_KEY");
  if (tavilyKey) {
    return {
      apiUrl: "https://api.tavily.com",
      apiKey: tavilyKey,
      provider: "tavily",
    };
  }

  return "Error: CRW_API_KEY or TAVILY_API_KEY not set.";
}

/** Resolve a legacy-only auth for fallback when CRW fails (e.g. 503). */
function resolveFallbackAuth(): AuthResult | null {
  const kortixToken = getEnv("KORTIX_TOKEN");
  const tavilyUrl = getEnv("TAVILY_API_URL");
  if (tavilyUrl) {
    const key = kortixToken || getEnv("TAVILY_API_KEY");
    if (key) return { apiUrl: tavilyUrl.replace(/\/+$/, ""), apiKey: key, provider: "tavily" };
  }
  const tavilyKey = getEnv("TAVILY_API_KEY");
  if (tavilyKey) return { apiUrl: "https://api.tavily.com", apiKey: tavilyKey, provider: "tavily" };
  return null;
}

async function searchCrw(
  q: string,
  auth: AuthResult,
  maxResults: number,
  topic: string,
  isAdvanced: boolean,
): Promise<{ query: string; data?: CrwSearchResult[]; error?: string }> {
  const body: Record<string, unknown> = {
    query: q,
    limit: maxResults,
    sources: topic === "news" ? ["news"] : ["web"],
  };
  if (isAdvanced) {
    body.scrapeOptions = { formats: ["markdown"], onlyMainContent: true };
  }

  const res = await fetch(`${auth.apiUrl}/v1/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    return { query: q, error: `CRW API error ${res.status}: ${await res.text()}` };
  }

  const json = (await res.json()) as CrwSearchResponse;
  if (!json.success) {
    return { query: q, error: json.error ?? "Search failed" };
  }

  let results: CrwSearchResult[];
  if (Array.isArray(json.data)) {
    results = json.data;
  } else {
    results = [...(json.data.web ?? []), ...(json.data.news ?? [])];
  }
  return { query: q, data: results };
}

async function searchTavily(
  q: string,
  auth: AuthResult,
  maxResults: number,
  topic: string,
  isAdvanced: boolean,
): Promise<{ query: string; data?: CrwSearchResult[]; answer?: string; images?: Array<{ url: string; description?: string }>; error?: string }> {
  const res = await fetch(`${auth.apiUrl}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: auth.apiKey,
      query: q,
      search_depth: isAdvanced ? "advanced" : "basic",
      topic: topic === "news" ? "news" : "general",
      max_results: maxResults,
      include_answer: true,
      include_images: true,
      include_image_descriptions: true,
    }),
  });

  if (!res.ok) {
    return { query: q, error: `Tavily API error ${res.status}: ${await res.text()}` };
  }

  const json = await res.json() as {
    results: Array<{ title: string; url: string; content: string; score: number; published_date?: string; publishedDate?: string }>;
    answer?: string;
    images?: Array<{ url: string; description?: string }>;
  };

  const results: CrwSearchResult[] = json.results.map((r) => ({
    url: r.url,
    title: r.title,
    description: r.content,
    score: r.score,
    publishedDate: r.published_date ?? r.publishedDate,
  }));
  return { query: q, data: results, answer: json.answer, images: json.images };
}

function formatResults(
  query: string,
  results: CrwSearchResult[],
  extra?: { answer?: string; images?: Array<{ url: string; description?: string }> },
): Record<string, unknown> {
  const output: Record<string, unknown> = {
    query,
    success: results.length > 0,
    results: results.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.description,
      score: r.score ?? 0,
      published_date: r.publishedDate ?? "",
    })),
  };
  // Preserve Tavily answer for UI search summary card
  if (extra?.answer) {
    output.answer = extra.answer;
  }
  // Preserve Tavily images for mobile WebSearchToolView
  if (extra?.images && extra.images.length > 0) {
    output.images = extra.images;
  }
  return output;
}

export default tool({
  description:
    "Search the web for up-to-date information using CRW. " +
    "Returns titles, URLs, snippets, and relevance scores. " +
    "Supports batch queries separated by |||. " +
    "Use topic='news' for current events. " +
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
      .describe("Search topic: 'general' (default) or 'news'"),
    search_depth: tool.schema
      .string()
      .optional()
      .describe(
        "Search depth: 'basic' (default) or 'advanced'. CRW uses scrapeOptions for advanced depth.",
      ),
  },
  async execute(args, _context) {
    const auth = resolveAuth();
    if (typeof auth === "string") return auth;

    const maxResults = Math.max(1, Math.min(args.num_results ?? 5, 20));
    const topic = args.topic ?? "general";
    const isAdvanced = args.search_depth === "advanced";

    const queries = args.query
      .split("|||")
      .map((q) => q.trim())
      .filter(Boolean);
    if (queries.length === 0) return "Error: empty query.";

    const searchOne = async (
      q: string,
    ): Promise<{ query: string; data?: CrwSearchResult[]; answer?: string; images?: Array<{ url: string; description?: string }>; error?: string }> => {
      try {
        if (auth.provider === "crw") {
          const result = await searchCrw(q, auth, maxResults, topic, isAdvanced);
          // If CRW returned an error (e.g. 503 "not configured"), try fallback
          if (result.error) {
            const fallback = resolveFallbackAuth();
            if (fallback) {
              return await searchTavily(q, fallback, maxResults, topic, isAdvanced);
            }
          }
          return result;
        }
        return await searchTavily(q, auth, maxResults, topic, isAdvanced);
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
      return JSON.stringify(formatResults(r.query, r.data!, { answer: r.answer, images: r.images }), null, 2);
    }

    return JSON.stringify(
      {
        batch_mode: true,
        total_queries: queries.length,
        results: results.map((r) => {
          if (r.error)
            return { query: r.query, success: false, error: r.error };
          return formatResults(r.query, r.data!, { answer: r.answer, images: r.images });
        }),
      },
      null,
      2,
    );
  },
});
