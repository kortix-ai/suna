import { tool } from "./lib/tool";
import { getEnv, getKortixRouterBase } from "./lib/get-env";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const TAVILY_DEFAULT_URL = "https://api.tavily.com";
const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";
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

interface ParallelResult {
  url: string;
  title?: string | null;
  excerpts: string[];
  publish_date?: string | null;
}

function textBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part: unknown) =>
    part && typeof part === "object" && "type" in part && part.type === "text" &&
    "text" in part && typeof part.text === "string" ? [part.text] : []);
}

function parallelPayload(result: { structuredContent?: unknown; content?: unknown }): {
  results: ParallelResult[];
  warnings?: string[] | null;
} {
  const text = textBlocks(result.content)[0];
  const payload = result.structuredContent ?? (text ? JSON.parse(text) : undefined);
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { results?: unknown }).results)) {
    throw new Error("Parallel returned an invalid search result.");
  }
  const data = payload as { results: unknown[]; warnings?: unknown };
  if (!data.results.every((item): item is ParallelResult =>
    !!item && typeof item === "object" &&
    typeof (item as ParallelResult).url === "string" &&
    Array.isArray((item as ParallelResult).excerpts) &&
    (item as ParallelResult).excerpts.every((excerpt) => typeof excerpt === "string")
  )) {
    throw new Error("Parallel returned an invalid search result.");
  }
  return {
    results: data.results as ParallelResult[],
    warnings: Array.isArray(data.warnings) ? data.warnings.filter((warning): warning is string => typeof warning === "string") : [],
  };
}

async function searchParallel(queries: string[], maxResults: number, signal?: AbortSignal, sessionID?: string) {
  // Identify this project so Parallel can measure aggregate free MCP usage.
  // Keep the value project-wide; do not add user or installation identifiers.
  const transport = new StreamableHTTPClientTransport(new URL(PARALLEL_MCP_URL), {
    requestInit: { headers: { "User-Agent": "Kortix" } },
    fetch: (input, init) => fetch(input, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([init?.signal, signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)]
        .filter((item): item is AbortSignal => !!item)),
    }),
  });
  const client = new Client({ name: "kortix", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools(undefined, { signal, timeout: SEARCH_TIMEOUT_MS });
    if (!tools.tools.some((entry) => entry.name === "web_search")) {
      throw new Error("Parallel MCP does not offer web_search.");
    }
    const results = [];
    for (const query of queries) {
      try {
        const response = await client.callTool({
          name: "web_search",
          arguments: {
            objective: query,
            search_queries: [query],
            ...(sessionID && sessionID.length <= 100 ? { session_id: sessionID } : {}),
          },
        }, undefined, { signal, timeout: SEARCH_TIMEOUT_MS });
        if (response.isError) {
          throw new Error(textBlocks(response.content).join("\n") || "Parallel search failed.");
        }
        const data = parallelPayload({
          structuredContent: response.structuredContent,
          content: response.content,
        });
        const warnings = [...(data.warnings ?? [])];
        if (data.results.length > maxResults) warnings.push(`Showing the first ${maxResults} Parallel results.`);
        if (data.results.slice(0, maxResults).some((item) => item.excerpts.join("\n").length > 1500)) {
          warnings.push("Long Parallel excerpts were shortened to 1,500 characters per result.");
        }
        results.push({
          query,
          success: true,
          provider: "parallel",
          results: data.results.slice(0, maxResults).map((item) => ({
            title: item.title ?? "",
            url: item.url,
            snippet: item.excerpts.join("\n").slice(0, 1500),
            published_date: item.publish_date ?? "",
          })),
          warnings,
        });
      } catch (error) {
        results.push({ query, success: false, provider: "parallel", error: String(error) });
      }
    }
    return queries.length === 1 ? JSON.stringify(results[0], null, 2) : JSON.stringify({
      batch_mode: true,
      total_queries: queries.length,
      results,
    }, null, 2);
  } finally {
    await client.close().catch(() => {});
  }
}

export default tool({
  description:
    "Search the web using Tavily (default) or free Parallel Search MCP. " +
    "Tavily returns titles, URLs, snippets, relevance scores, images, and an AI answer. Parallel returns source URLs and excerpts without a key. " +
    "Supports batch queries separated by |||. " +
    "Tavily supports topic and search_depth; Parallel does not. " +
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
      .describe("Results per query (1-20). Default: 5. Parallel applies this as a local result limit."),
    provider: tool.schema
      .enum(["tavily", "parallel"])
      .optional()
      .describe("Search provider. Defaults to Tavily; select 'parallel' for keyless Parallel Search MCP."),
    topic: tool.schema
      .string()
      .optional()
      .describe("Tavily only: 'general' (default), 'news', or 'finance'"),
    search_depth: tool.schema
      .string()
      .optional()
      .describe(
        "Tavily only: 'basic' (default) or 'advanced'. Parallel does not support search depth.",
      ),
  },
  async execute(args, context) {
    const queries = args.query
      .split("|||")
      .map((q) => q.trim())
      .filter(Boolean);
    if (queries.length === 0) return "Error: empty query.";

    const maxResults = Math.max(1, Math.min(args.num_results ?? 5, 20));
    if (args.provider === "parallel") {
      if (args.topic !== undefined || args.search_depth !== undefined) {
        return "Error: Parallel does not support topic or search_depth. Remove these options or select Tavily.";
      }
      try {
        return await searchParallel(queries, maxResults, context?.abort, context?.sessionID);
      } catch (error) {
        return JSON.stringify({ query: args.query, success: false, provider: "parallel", error: String(error) }, null, 2);
      }
    }

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

    const topic = (args.topic as "general" | "news" | "finance") ?? "general";

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
