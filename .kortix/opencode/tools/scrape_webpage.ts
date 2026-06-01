import { tool } from "@opencode-ai/plugin";
import FirecrawlApp from "@mendable/firecrawl-js";
import { getEnv, getKortixRouterBase } from "./lib/get-env";

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
    // Route through the Kortix router (derived from KORTIX_API_URL) and auth with
    // KORTIX_TOKEN; the router injects the real upstream key. Fall back to a raw
    // FIRECRAWL_API_KEY only when KORTIX_API_URL is unset (self-host/direct).
    const apiBaseURL = getKortixRouterBase("firecrawl") ?? undefined;
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
