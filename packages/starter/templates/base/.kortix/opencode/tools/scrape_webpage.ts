import { tool } from "@opencode-ai/plugin";
import FirecrawlApp from "@mendable/firecrawl-js";
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

async function scrapeOne(
  client: FirecrawlApp,
  url: string,
  includeHtml: boolean,
  retries = 3,
): Promise<ScrapeResult> {
  const formats: ("markdown" | "html")[] = includeHtml
    ? ["markdown", "html"]
    : ["markdown"];

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = (await client.scrape(url, {
        formats,
        timeout: 30000,
      })) as Record<string, unknown>;

      const metadata = (response.metadata ?? {}) as Record<string, string>;
      const markdown = (response.markdown ?? "") as string;
      const html = (response.html ?? "") as string;

      const result: ScrapeResult = {
        url,
        success: true,
        title: metadata.title ?? "",
        content: markdown,
        content_length: markdown.length,
      };

      if (includeHtml && html) result.html = html;
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
    "Fetch and extract content from web pages using Firecrawl. " +
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
    const apiBaseURL = getEnv("FIRECRAWL_API_URL");
    // When routed through the Kortix proxy (FIRECRAWL_API_URL is set), use KORTIX_TOKEN
    // for auth — the proxy validates it and injects the real Firecrawl API key.
    // When hitting the real Firecrawl API directly, use the user's own FIRECRAWL_API_KEY.
    const apiKey = apiBaseURL
      ? getEnv("KORTIX_TOKEN")
      : getEnv("FIRECRAWL_API_KEY");
    if (!apiKey) return apiBaseURL
      ? "Error: KORTIX_TOKEN not set."
      : "Error: FIRECRAWL_API_KEY not set.";

    const client = new FirecrawlApp({
      apiKey,
      apiUrl: apiBaseURL ?? "https://api.firecrawl.dev",
    });
    const includeHtml = args.include_html ?? false;

    const urlList = args.urls
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean);
    if (urlList.length === 0) return "Error: no valid URLs provided.";

    const results = await Promise.all(
      urlList.map((u) => scrapeOne(client, u, includeHtml)),
    );

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
