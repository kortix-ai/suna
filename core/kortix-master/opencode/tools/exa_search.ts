import { tool } from "@opencode-ai/plugin";
import { getEnv } from "./lib/get-env";

const EXA_DEFAULT_URL = "https://api.exa.ai";

// ── Types ──────────────────────────────────────────────────────────────────

interface ExaResult {
  title: string;
  url: string;
  id: string;
  publishedDate?: string | null;
  author?: string | null;
  text?: string;
  highlights?: string[];
  highlightScores?: number[];
  summary?: string;
  image?: string;
  favicon?: string;
}

interface ExaResponse {
  requestId: string;
  results: ExaResult[];
  searchType?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function getBaseUrl(): string {
  const override = getEnv("EXA_API_URL");
  return (override || EXA_DEFAULT_URL).replace(/\/+$/, "");
}

function buildSnippet(r: ExaResult): string {
  if (r.highlights && r.highlights.length > 0) return r.highlights.join(" … ");
  if (r.summary) return r.summary;
  if (r.text) return r.text.slice(0, 500);
  return "";
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
        published_date: r.publishedDate ?? "",
        author: r.author ?? "",
      })),
      search_type: response.searchType ?? "",
    },
    null,
    2,
  );
}

function parseDomains(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const domains = raw
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  return domains.length > 0 ? domains : undefined;
}

// ── Tool ───────────────────────────────────────────────────────────────────

export default tool({
  description:
    "Search the web using the Exa AI-powered search engine. " +
    "Returns titles, URLs, snippets, and published dates. " +
    "Supports neural (semantic) and auto search types. " +
    "Supports batch queries separated by |||. " +
    "Use category filtering for targeted results (company, news, research paper, etc.). " +
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
      .describe("Results per query (1-100). Default: 5"),
    search_type: tool.schema
      .string()
      .optional()
      .describe(
        "Search type: 'auto' (default, intelligently combines methods), " +
          "'neural' (semantic/embedding-based), or 'fast' (streamlined)",
      ),
    content_mode: tool.schema
      .string()
      .optional()
      .describe(
        "Content retrieval mode: 'highlights' (key passages, default), " +
          "'text' (full page text), 'summary' (AI summary), or 'all' (text + highlights + summary)",
      ),
    category: tool.schema
      .string()
      .optional()
      .describe(
        "Category filter: 'company', 'research paper', 'news', " +
          "'personal site', 'financial report', or 'people'",
      ),
    include_domains: tool.schema
      .string()
      .optional()
      .describe(
        "Comma-separated domains to restrict results to (e.g. 'arxiv.org,nature.com')",
      ),
    exclude_domains: tool.schema
      .string()
      .optional()
      .describe(
        "Comma-separated domains to exclude (e.g. 'reddit.com,quora.com')",
      ),
    include_text: tool.schema
      .string()
      .optional()
      .describe("Only return results containing this text in the page body"),
    exclude_text: tool.schema
      .string()
      .optional()
      .describe("Exclude results containing this text in the page body"),
    start_date: tool.schema
      .string()
      .optional()
      .describe(
        "Only include results published after this date (ISO 8601, e.g. '2024-01-01')",
      ),
    end_date: tool.schema
      .string()
      .optional()
      .describe(
        "Only include results published before this date (ISO 8601, e.g. '2025-01-01')",
      ),
  },
  async execute(args, _context) {
    const apiBaseURL = getEnv("EXA_API_URL");
    // When routed through the Kortix proxy (EXA_API_URL is set), use KORTIX_TOKEN
    // for auth — the proxy validates it and injects the real Exa API key.
    // When hitting the real Exa API directly, use the user's own EXA_API_KEY.
    const apiKey = apiBaseURL
      ? getEnv("KORTIX_TOKEN")
      : getEnv("EXA_API_KEY");
    if (!apiKey)
      return apiBaseURL
        ? "Error: KORTIX_TOKEN not set."
        : "Error: EXA_API_KEY not set.";

    const numResults = Math.max(1, Math.min(args.num_results ?? 5, 100));
    const searchType = args.search_type ?? "auto";
    const contentMode = args.content_mode ?? "highlights";

    const queries = args.query
      .split("|||")
      .map((q) => q.trim())
      .filter(Boolean);
    if (queries.length === 0) return "Error: empty query.";

    const headers: Record<string, string> = {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
      "x-exa-integration": "suna",
    };

    const includeDomains = parseDomains(args.include_domains);
    const excludeDomains = parseDomains(args.exclude_domains);

    const buildContents = (): Record<string, unknown> => {
      switch (contentMode) {
        case "text":
          return { text: { maxCharacters: 3000 } };
        case "summary":
          return { summary: {} };
        case "all":
          return {
            text: { maxCharacters: 3000 },
            highlights: true,
            summary: {},
          };
        case "highlights":
        default:
          return { highlights: true };
      }
    };

    const searchOne = async (
      q: string,
    ): Promise<{ query: string; data?: ExaResponse; error?: string }> => {
      try {
        const body: Record<string, unknown> = {
          query: q,
          type: searchType,
          numResults,
          contents: buildContents(),
        };

        if (args.category) body.category = args.category;
        if (includeDomains) body.includeDomains = includeDomains;
        if (excludeDomains) body.excludeDomains = excludeDomains;
        if (args.include_text) body.includeText = [args.include_text];
        if (args.exclude_text) body.excludeText = [args.exclude_text];
        if (args.start_date) body.startPublishedDate = args.start_date;
        if (args.end_date) body.endPublishedDate = args.end_date;

        const res = await fetch(`${getBaseUrl()}/search`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const text = await res.text();
          return { query: q, error: `Exa API returned ${res.status}: ${text}` };
        }

        const data = (await res.json()) as ExaResponse;
        return { query: q, data };
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
            success: d.results.length > 0,
            results: d.results.map((res) => ({
              title: res.title,
              url: res.url,
              snippet: buildSnippet(res),
              published_date: res.publishedDate ?? "",
              author: res.author ?? "",
            })),
            search_type: d.searchType ?? "",
          };
        }),
      },
      null,
      2,
    );
  },
});
