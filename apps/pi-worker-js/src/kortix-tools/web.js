// THE THREE WEB TOOLS, AS KORTIXD'S PI HARNESS HAS THEM.
//
// `web_search` (Tavily), `image_search` (Serper) and `scrape_webpage`
// (Firecrawl): a port of apps/kortix-sandbox-agent-server/src/harness/pi/
// kortix-web-tools.ts. Names, descriptions, arguments, endpoints, headers,
// output JSON and error texts are the same, so a skill that names them and the
// client's tool views work on a cell unchanged.
//
// Each call goes to the API's billed router proxy (`<api>/v1/router/<service>`)
// with the sandbox token; the router holds the upstream key. A session with no
// control plane calls the upstream itself with the project's own key.
//
// Two differences from kortixd, both forced by the isolate:
//  - the env is the SESSION's (the control plane pushes it), not `process.env`;
//  - `fetch` and the retry `sleep` are injectable, so the suite drives every
//    branch with no network and no real backoff.
import { Type } from "typebox";

export const SEARCH_TIMEOUT_MS = 60_000;
export const SCRAPE_TIMEOUT_MS = 35_000;

const text = (value) => ({ content: [{ type: "text", text: value }], details: undefined });
const json = (value) => text(JSON.stringify(value, null, 2));
const message = (err) => (err instanceof Error ? err.message : String(err));

/**
 * kortixd's `readControlPlaneEnv`, over the session env: the API root always
 * ends in `/v1`, whether the env spells it or not.
 */
export function controlPlane(env) {
  const apiUrl = String(env?.KORTIX_API_URL ?? "").trim().replace(/\/+$/, "");
  const token = String(env?.KORTIX_TOKEN ?? "").trim() || null;
  return { apiRoot: apiUrl ? (apiUrl.endsWith("/v1") ? apiUrl : `${apiUrl}/v1`) : null, token };
}

/** The router proxy when a control plane exists, else the upstream with the project's own key. */
export function upstream(env, service, direct, keyName) {
  const { apiRoot, token } = controlPlane(env);
  if (apiRoot) {
    if (!token) throw new Error("KORTIX_TOKEN is not set.");
    return { base: `${apiRoot}/router/${service}`, key: token };
  }
  const key = String(env?.[keyName] ?? "").trim();
  if (!key) throw new Error(`${keyName} is not set.`);
  return { base: direct, key };
}

function split(value, separator, empty) {
  const parts = String(value ?? "").split(separator).map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error(empty);
  return parts;
}

/** The turn's signal and a timeout, whichever fires first. */
function within(ms, signal) {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);
  const ctl = new AbortController();
  for (const s of [signal, timeout]) {
    if (s.aborted) { ctl.abort(s.reason); break; }
    s.addEventListener("abort", () => ctl.abort(s.reason), { once: true });
  }
  return ctl.signal;
}

const sessionEnv = (env) => (typeof env === "function" ? env() : env) ?? {};
const fetchOf = (f) => f ?? ((...a) => globalThis.fetch(...a));

const webSearchSchema = Type.Object({
  query: Type.String({ description: "Search query. For batch, separate with ||| (e.g. 'query one ||| query two')" }),
  num_results: Type.Optional(Type.Number({ description: "Results per query (1-20). Default: 5" })),
  topic: Type.Optional(Type.String({ description: "Search topic: 'general' (default), 'news', or 'finance'" })),
  search_depth: Type.Optional(
    Type.String({
      description:
        "Search depth: 'basic' (faster, cheaper, default) or 'advanced' (slower, more thorough). Use 'basic' for most queries. Reserve 'advanced' for deep research where comprehensiveness matters.",
    }),
  ),
});

/** `env`: the session env, or a function that returns it at call time. */
export function createWebSearchTool({ env, fetch } = {}) {
  const doFetch = fetchOf(fetch);
  return {
    name: "web_search",
    label: "web_search",
    description:
      "Search the web for up-to-date information using Tavily. " +
      "Returns titles, URLs, snippets, relevance scores, images, and a synthesized AI answer. " +
      "Supports batch queries separated by |||. " +
      "Use topic='news' for current events, topic='finance' for financial data. " +
      "After using results, ALWAYS include a Sources section with markdown hyperlinks.",
    parameters: webSearchSchema,
    async execute(_id, args, signal) {
      const { base, key } = upstream(sessionEnv(env), "tavily", "https://api.tavily.com", "TAVILY_API_KEY");
      const queries = split(args.query, "|||", "The query is empty.");
      const searchOne = async (query) => {
        try {
          const response = await doFetch(`${base}/search`, {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              query,
              search_depth: args.search_depth || "basic",
              topic: args.topic || "general",
              max_results: Math.max(1, Math.min(args.num_results ?? 5, 20)),
              include_answer: true,
              include_images: true,
              include_image_descriptions: true,
            }),
            signal: within(SEARCH_TIMEOUT_MS, signal),
          });
          const body = await response.text();
          if (!response.ok) throw new Error(`${response.status} Error: ${body}`);
          const data = JSON.parse(body);
          const results = data.results ?? [];
          return {
            query,
            success: results.length > 0 || !!data.answer,
            answer: data.answer ?? "",
            results: results.map((r) => ({
              title: r.title ?? "",
              url: r.url ?? "",
              snippet: r.content ?? "",
              score: r.score ?? 0,
              published_date: r.published_date ?? "",
            })),
            images: (data.images ?? []).map((image) =>
              typeof image === "string" ? { url: image, description: "" } : { url: image.url ?? "", description: image.description ?? "" },
            ),
            response_time_ms: data.response_time,
          };
        } catch (err) {
          return { query, success: false, error: String(err) };
        }
      };
      const results = await Promise.all(queries.map(searchOne));
      if (results.length === 1) return json(results[0]);
      return json({ batch_mode: true, total_queries: queries.length, results });
    },
  };
}

const imageSearchSchema = Type.Object({
  query: Type.String({ description: "Image search query. For batch, separate with ||| (e.g. 'cats ||| dogs')" }),
  num_results: Type.Optional(Type.Number({ description: "Images per query (1-100). Default: 12" })),
});

function serperImages(query, data) {
  const images = (data.images ?? []).map((image) => ({
    url: image.imageUrl,
    title: image.title ?? "",
    source: image.link ?? "",
    width: image.imageWidth ?? 0,
    height: image.imageHeight ?? 0,
  }));
  return { query, total: images.length, images };
}

export function createImageSearchTool({ env, fetch } = {}) {
  const doFetch = fetchOf(fetch);
  return {
    name: "image_search",
    label: "image_search",
    description:
      "Search for images using the Serper Google Images API. " +
      "Returns image URLs with titles, source pages, and dimensions. " +
      "Supports batch queries separated by |||. " +
      "Use specific descriptive queries including topic/brand names for best results.",
    parameters: imageSearchSchema,
    async execute(_id, args, signal) {
      const { base, key } = upstream(sessionEnv(env), "serper", "https://google.serper.dev", "SERPER_API_KEY");
      const queries = split(args.query, "|||", "The query is empty.");
      const num = Math.max(1, Math.min(args.num_results ?? 12, 100));
      const payload = queries.map((q) => ({ q, num }));
      const response = await doFetch(`${base}/images`, {
        method: "POST",
        headers: { "X-API-KEY": key, "Content-Type": "application/json" },
        body: JSON.stringify(payload.length === 1 ? payload[0] : payload),
        signal: within(SEARCH_TIMEOUT_MS, signal),
      });
      if (!response.ok) throw new Error(`Serper API returned ${response.status}: ${await response.text()}`);
      const data = await response.json();
      if (queries.length > 1) {
        const all = Array.isArray(data) ? data : [data];
        return json({ batch_mode: true, results: all.map((entry, i) => serperImages(queries[i], entry)) });
      }
      const single = serperImages(queries[0], Array.isArray(data) ? (data[0] ?? {}) : data);
      return single.total === 0 ? text(`No images found for: '${queries[0]}'`) : json(single);
    },
  };
}

const scrapeSchema = Type.Object({
  urls: Type.String({ description: "URLs to scrape, comma-separated (e.g. 'https://example.com/a,https://example.com/b')" }),
  include_html: Type.Optional(Type.Boolean({ description: "Include raw HTML alongside markdown. Default: false" })),
});

async function scrapeOne({ doFetch, sleep }, base, key, url, includeHtml, signal) {
  const retries = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await doFetch(`${base}/v2/scrape`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ url, formats: includeHtml ? ["markdown", "html"] : ["markdown"], timeout: 30000 }),
        signal: within(SCRAPE_TIMEOUT_MS, signal),
      });
      const raw = await response.text();
      const body = JSON.parse(raw);
      if (!response.ok || !body.success) throw new Error(body.error || `${response.status} Error: ${raw}`);
      const data = body.data ?? {};
      const metadata = data.metadata ?? {};
      const markdown = data.markdown ?? "";
      const html = data.html ?? "";
      return {
        url,
        success: true,
        title: metadata.title ?? "",
        content: markdown,
        content_length: markdown.length,
        ...(includeHtml && html ? { html } : {}),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      };
    } catch (err) {
      const reason = message(err);
      // Only a timeout is worth a second request; an aborted turn is not.
      if (/timeout/i.test(reason) && attempt < retries && !signal?.aborted) {
        await sleep(2 ** attempt * 1000);
        continue;
      }
      return { url, success: false, error: reason };
    }
  }
}

export function createScrapeWebpageTool({ env, fetch, sleep } = {}) {
  const deps = { doFetch: fetchOf(fetch), sleep: sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))) };
  return {
    name: "scrape_webpage",
    label: "scrape_webpage",
    description:
      "Fetch and extract content from web pages using Firecrawl. " +
      "Converts HTML to clean markdown. " +
      "Supports multiple URLs separated by commas. " +
      "Batch URLs in a single call for efficiency. " +
      "For GitHub URLs, prefer gh CLI via Bash instead.",
    parameters: scrapeSchema,
    async execute(_id, args, signal) {
      const { base, key } = upstream(sessionEnv(env), "firecrawl", "https://api.firecrawl.dev", "FIRECRAWL_API_KEY");
      const urls = split(args.urls, ",", "No valid URLs provided.");
      const results = await Promise.all(urls.map((url) => scrapeOne(deps, base, key, url, args.include_html ?? false, signal)));
      const successful = results.filter((result) => result.success).length;
      if (successful === 0) {
        throw new Error(`Failed to scrape all ${results.length} URLs. ${results.map((r) => `${r.url}: ${r.error}`).join("; ")}`);
      }
      if (results.length === 1) return json(results[0]);
      return json({ total: results.length, successful, failed: results.length - successful, results });
    },
  };
}
