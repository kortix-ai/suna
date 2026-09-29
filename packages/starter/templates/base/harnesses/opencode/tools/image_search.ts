import { tool } from "./lib/tool";
import { getEnv, getKortixRouterBase } from "./lib/get-env";

const SERPER_DEFAULT_URL = "https://google.serper.dev";

function getSerperImagesUrl(): string {
  const override = getKortixRouterBase("serper");
  const base = override || SERPER_DEFAULT_URL;
  return `${base.replace(/\/+$/, "")}/images`;
}

interface SerperImage {
  imageUrl: string;
  title?: string;
  link?: string;
  imageWidth?: number;
  imageHeight?: number;
}

interface SerperResponse {
  images?: SerperImage[];
  searchParameters?: Record<string, unknown>;
}

interface ImageResult {
  url: string;
  title: string;
  source: string;
  width: number;
  height: number;
}

function extractImages(data: SerperResponse): ImageResult[] {
  return (data.images ?? []).map((img) => ({
    url: img.imageUrl,
    title: img.title ?? "",
    source: img.link ?? "",
    width: img.imageWidth ?? 0,
    height: img.imageHeight ?? 0,
  }));
}

export default tool({
  description:
    "Search for images using the Serper Google Images API. " +
    "Returns image URLs with titles, source pages, and dimensions. " +
    "Supports batch queries separated by |||. " +
    "Use specific descriptive queries including topic/brand names for best results.",
  args: {
    query: tool.schema
      .string()
      .describe(
        "Image search query. For batch, separate with ||| (e.g. 'cats ||| dogs')",
      ),
    num_results: tool.schema
      .number()
      .optional()
      .describe("Images per query (1-100). Default: 12"),
  },
  async execute(args, _context) {
    const serperUrlOverride = getKortixRouterBase("serper") ?? undefined;
    // Route through the Kortix router (derived from KORTIX_API_URL); auth with
    // KORTIX_SANDBOX_TOKEN (KORTIX_TOKEN kept as a legacy fallback). Fall back
    // to a raw SERPER_API_KEY only when unset.
    const apiKey = serperUrlOverride
      ? getEnv("KORTIX_SANDBOX_TOKEN") || getEnv("KORTIX_TOKEN")
      : getEnv("SERPER_API_KEY");
    if (!apiKey) return serperUrlOverride
      ? "Error: KORTIX_SANDBOX_TOKEN not set."
      : "Error: SERPER_API_KEY not set.";

    const numResults = Math.max(1, Math.min(args.num_results ?? 12, 100));
    const queries = args.query
      .split("|||")
      .map((q) => q.trim())
      .filter(Boolean);
    if (queries.length === 0) return "Error: empty query.";

    const headers = {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
    };

    try {
      if (queries.length === 1) {
        const res = await fetch(getSerperImagesUrl(), {
          method: "POST",
          headers,
          body: JSON.stringify({ q: queries[0], num: numResults }),
        });
        if (!res.ok)
          return `Error: Serper API returned ${res.status}: ${await res.text()}`;

        const data = (await res.json()) as SerperResponse;
        const images = extractImages(data);

        if (images.length === 0) return `No images found for: '${queries[0]}'`;

        return JSON.stringify(
          { query: queries[0], total: images.length, images },
          null,
          2,
        );
      }

      const payload = queries.map((q) => ({ q, num: numResults }));
      const res = await fetch(getSerperImagesUrl(), {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      if (!res.ok)
        return `Error: Serper API returned ${res.status}: ${await res.text()}`;

      const data = await res.json();
      const dataArr: SerperResponse[] = Array.isArray(data) ? data : [data];

      const results = await Promise.all(
        dataArr.map(async (d, i) => {
          const images = extractImages(d);
          return { query: queries[i], total: images.length, images };
        }),
      );

      return JSON.stringify({ batch_mode: true, results }, null, 2);
    } catch (e) {
      return `Error: ${String(e)}`;
    }
  },
});
