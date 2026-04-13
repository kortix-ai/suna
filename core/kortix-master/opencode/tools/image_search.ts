import { tool } from "@opencode-ai/plugin";
import { getEnv } from "./lib/get-env";

interface CrwImageResult {
  url: string;
  title?: string;
  description?: string;
  imageUrl: string;
  thumbnailUrl?: string;
  imageFormat?: string;
  resolution?: string;
  position?: number;
}

interface CrwSearchResponse {
  success: boolean;
  data: { images?: CrwImageResult[] } | CrwImageResult[];
  error?: string;
}

interface EnrichedImage {
  url: string;
  title: string;
  source: string;
  width: number;
  height: number;
  description: string;
  thumbnail_url: string;
  format: string;
}

function parseResolution(res?: string): { width: number; height: number } {
  if (!res) return { width: 0, height: 0 };
  const match = res.match(/(\d+)\s*[x×]\s*(\d+)/i);
  if (!match) return { width: 0, height: 0 };
  return { width: parseInt(match[1]!, 10), height: parseInt(match[2]!, 10) };
}

function mapImages(images: CrwImageResult[]): EnrichedImage[] {
  return images.map((img) => {
    const { width, height } = parseResolution(img.resolution);
    return {
      url: img.imageUrl || img.url,
      title: img.title ?? "",
      source: img.url ?? "",
      width,
      height,
      description: img.description ?? "",
      thumbnail_url: img.thumbnailUrl ?? img.imageUrl ?? "",
      format: img.imageFormat ?? "",
    };
  });
}

interface AuthResult {
  apiUrl: string;
  apiKey: string;
  provider: "crw" | "serper";
}

async function searchImagesCrw(
  q: string,
  auth: AuthResult,
  limit: number,
): Promise<{ query: string; images?: EnrichedImage[]; error?: string }> {
  const res = await fetch(`${auth.apiUrl}/v1/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.apiKey}`,
    },
    body: JSON.stringify({ query: q, limit, sources: ["images"] }),
  });

  if (!res.ok) {
    return { query: q, error: `CRW API error ${res.status}: ${await res.text()}` };
  }

  const json = (await res.json()) as CrwSearchResponse;
  if (!json.success) {
    return { query: q, error: json.error ?? "Image search failed" };
  }

  let rawImages: CrwImageResult[];
  if (Array.isArray(json.data)) {
    rawImages = json.data;
  } else {
    rawImages = json.data.images ?? [];
  }
  return { query: q, images: mapImages(rawImages) };
}

async function searchImagesSerper(
  q: string,
  auth: AuthResult,
  numResults: number,
): Promise<{ query: string; images?: EnrichedImage[]; error?: string }> {
  const res = await fetch(`${auth.apiUrl}/images`, {
    method: "POST",
    headers: {
      "X-API-KEY": auth.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q, num: numResults }),
  });

  if (!res.ok) {
    return { query: q, error: `Serper API error ${res.status}: ${await res.text()}` };
  }

  const data = (await res.json()) as { images?: Array<{ imageUrl: string; title?: string; link?: string; imageWidth?: number; imageHeight?: number }> };
  const images: EnrichedImage[] = (data.images ?? []).map((img) => ({
    url: img.imageUrl,
    title: img.title ?? "",
    source: img.link ?? "",
    width: img.imageWidth ?? 0,
    height: img.imageHeight ?? 0,
    description: "",
    thumbnail_url: img.imageUrl,
    format: "",
  }));
  return { query: q, images };
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

  // Legacy Serper proxy path
  const serperUrl = getEnv("SERPER_API_URL");
  if (serperUrl) {
    const key = kortixToken || getEnv("SERPER_API_KEY");
    if (!key) return "Error: KORTIX_TOKEN or SERPER_API_KEY not set.";
    return {
      apiUrl: serperUrl.replace(/\/+$/, ""),
      apiKey: key,
      provider: "serper",
    };
  }

  // Direct Serper (no proxy, no CRW)
  const serperKey = getEnv("SERPER_API_KEY");
  if (serperKey) {
    return {
      apiUrl: "https://google.serper.dev",
      apiKey: serperKey,
      provider: "serper",
    };
  }

  return "Error: CRW_API_KEY or SERPER_API_KEY not set.";
}

/** Resolve a legacy-only auth for fallback when CRW fails (e.g. 503). */
function resolveFallbackAuth(): AuthResult | null {
  const kortixToken = getEnv("KORTIX_TOKEN");
  const serperUrl = getEnv("SERPER_API_URL");
  if (serperUrl) {
    const key = kortixToken || getEnv("SERPER_API_KEY");
    if (key) return { apiUrl: serperUrl.replace(/\/+$/, ""), apiKey: key, provider: "serper" };
  }
  const serperKey = getEnv("SERPER_API_KEY");
  if (serperKey) return { apiUrl: "https://google.serper.dev", apiKey: serperKey, provider: "serper" };
  return null;
}

export default tool({
  description:
    "Search for images using CRW image search. " +
    "Returns image URLs with titles, source pages, dimensions, descriptions, and thumbnails. " +
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
      .describe("Images per query (1-20). Default: 5"),
  },
  async execute(args, _context) {
    const auth = resolveAuth();
    if (typeof auth === "string") return auth;

    const numResults = Math.max(1, Math.min(args.num_results ?? 5, 20));
    const queries = args.query
      .split("|||")
      .map((q: string) => q.trim())
      .filter(Boolean);
    if (queries.length === 0) return "Error: empty query.";

    const searchOne = async (
      q: string,
    ): Promise<{ query: string; images?: EnrichedImage[]; error?: string }> => {
      try {
        if (auth.provider === "crw") {
          const result = await searchImagesCrw(q, auth, numResults);
          // If CRW returned an error (e.g. 503 "not configured"), try fallback
          if (result.error) {
            const fallback = resolveFallbackAuth();
            if (fallback) {
              return await searchImagesSerper(q, fallback, numResults);
            }
          }
          return result;
        }
        return await searchImagesSerper(q, auth, numResults);
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
      if (!r.images || r.images.length === 0)
        return `No images found for: '${r.query}'`;
      return JSON.stringify(
        { query: r.query, total: r.images.length, images: r.images },
        null,
        2,
      );
    }

    return JSON.stringify(
      {
        batch_mode: true,
        results: results.map((r) => {
          if (r.error) return { query: r.query, success: false, error: r.error };
          return {
            query: r.query,
            total: r.images?.length ?? 0,
            images: r.images ?? [],
          };
        }),
      },
      null,
      2,
    );
  },
});
