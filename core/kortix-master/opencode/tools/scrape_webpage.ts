import { tool } from "@opencode-ai/plugin";
import { getEnv } from "./lib/get-env";

interface ScrapeResult {
  url: string;
  success: boolean;
  title?: string;
  content?: string;
  content_length?: number;
  html?: string;
  metadata?: Record<string, unknown>;
  error?: string;
}

interface CrwScrapeResponse {
  success: boolean;
  data?: {
    markdown?: string;
    html?: string;
    metadata?: Record<string, unknown>;
  };
  error?: string;
}

interface AuthResult {
  apiUrl: string;
  apiKey: string;
  provider: "crw" | "firecrawl";
}

function isRouterProxy(url: string): boolean {
  return url.includes("/v1/router/");
}

function resolveAuth(): AuthResult | string {
  const crwUrl = getEnv("CRW_API_URL");
  const crwKey = getEnv("CRW_API_KEY");
  const firecrawlUrl = getEnv("FIRECRAWL_API_URL");
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

  if (firecrawlUrl) {
    const key = kortixToken || getEnv("FIRECRAWL_API_KEY");
    if (!key) return "Error: FIRECRAWL_API_KEY not set.";
    return {
      apiUrl: firecrawlUrl.replace(/\/+$/, ""),
      apiKey: key,
      provider: "firecrawl",
    };
  }

  const firecrawlKey = getEnv("FIRECRAWL_API_KEY");
  if (firecrawlKey) {
    return {
      apiUrl: "https://api.firecrawl.dev",
      apiKey: firecrawlKey,
      provider: "firecrawl",
    };
  }

  return "Error: CRW_API_KEY or FIRECRAWL_API_KEY not set.";
}

/** Resolve a legacy-only auth for fallback when CRW fails (e.g. 503). */
function resolveFallbackAuth(): AuthResult | null {
  const kortixToken = getEnv("KORTIX_TOKEN");
  const firecrawlUrl = getEnv("FIRECRAWL_API_URL");
  if (firecrawlUrl) {
    const key = kortixToken || getEnv("FIRECRAWL_API_KEY");
    if (key) return { apiUrl: firecrawlUrl.replace(/\/+$/, ""), apiKey: key, provider: "firecrawl" };
  }
  const firecrawlKey = getEnv("FIRECRAWL_API_KEY");
  if (firecrawlKey) return { apiUrl: "https://api.firecrawl.dev", apiKey: firecrawlKey, provider: "firecrawl" };
  return null;
}

/** Check if the current auth points to a CRW endpoint. */
function isCrwAuth(auth: AuthResult): boolean {
  return auth.provider === "crw";
}

async function scrapeOne(
  auth: AuthResult,
  url: string,
  includeHtml: boolean,
  retries = 3,
): Promise<ScrapeResult> {
  const formats: string[] = includeHtml ? ["markdown", "html"] : ["markdown"];

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${auth.apiUrl}/v1/scrape`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${auth.apiKey}`,
        },
        body: JSON.stringify({ url, formats, timeout: 30000 }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { url, success: false, error: `API error ${res.status}: ${text.slice(0, 300)}` };
      }

      const json = (await res.json()) as CrwScrapeResponse;
      if (!json.success || !json.data) {
        return { url, success: false, error: json.error ?? "Scrape failed" };
      }

      const { data } = json;
      const markdown = data.markdown ?? "";
      const metadata = data.metadata ?? {};

      const result: ScrapeResult = {
        url,
        success: true,
        title: (metadata as Record<string, string>).title ?? "",
        content: markdown,
        content_length: markdown.length,
      };

      if (includeHtml && data.html) result.html = data.html;
      if (Object.keys(metadata).length > 0) result.metadata = metadata;
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isTimeout = msg.includes("timeout") || msg.includes("Timeout");

      if (isTimeout && attempt < retries) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
        continue;
      }
      return { url, success: false, error: msg };
    }
  }
  return { url, success: false, error: "max retries exceeded" };
}

export default tool({
  description:
    "Fetch and extract content from web pages using CRW. " +
    "Converts HTML to clean markdown. " +
    "Supports multiple URLs separated by commas. " +
    "Batch URLs in a single call for efficiency. " +
    "For GitHub URLs, prefer gh CLI via Bash instead.",
  args: {
    urls: tool.schema
      .string()
      .describe(
        "URLs to scrape, comma-separated (e.g. 'https://example.com/a,https://example.com/b')",
      ),
    include_html: tool.schema
      .boolean()
      .optional()
      .describe("Include raw HTML alongside markdown. Default: false"),
  },
  async execute(args, _context) {
    const auth = resolveAuth();
    if (typeof auth === "string") return auth;

    const includeHtml = args.include_html ?? false;

    const urlList = args.urls
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean);
    if (urlList.length === 0) return "Error: no valid URLs provided.";

    let results = await Promise.all(
      urlList.map((u) => scrapeOne(auth, u, includeHtml)),
    );

    // Retry failed CRW scrapes through the legacy provider (e.g. Firecrawl).
    // Handles both total failures (503 "not configured") and partial failures
    // (some URLs succeed via CRW but others time out or 5xx).
    if (isCrwAuth(auth) && results.some((r) => !r.success)) {
      const fallback = resolveFallbackAuth();
      if (fallback) {
        results = await Promise.all(
          results.map((r, i) =>
            r.success ? r : scrapeOne(fallback, urlList[i]!, includeHtml),
          ),
        );
      }
    }

    const successful = results.filter((r) => r.success).length;
    const failed = results.length - successful;

    if (successful === 0) {
      const errors = results.map((r) => `${r.url}: ${r.error}`).join("; ");
      return `Error: Failed to scrape all ${results.length} URLs. ${errors}`;
    }

    if (urlList.length === 1) return JSON.stringify(results[0], null, 2);

    return JSON.stringify(
      { total: results.length, successful, failed, results },
      null,
      2,
    );
  },
});
