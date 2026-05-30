import { tool } from "@opencode-ai/plugin";
import Replicate from "replicate";
import { getEnv } from "./lib/get-env";

const SERPER_DEFAULT_URL = "https://google.serper.dev";

function getSerperImagesUrl(): string {
  const override = getEnv("SERPER_API_URL");
  const base = override || SERPER_DEFAULT_URL;
  return `${base.replace(/\/+$/, "")}/images`;
}
const MOONDREAM_MODEL =
  "lucataco/moondream2:72ccb656353c348c1385df54b237eeb7bfa874bf11486cf0b9473e691b662d31";
const MOONDREAM_PROMPT =
  "Describe this image in detail. Include any text visible in the image.";
const IMAGE_DOWNLOAD_TIMEOUT_MS = 15_000;

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

interface EnrichedImage {
  url: string;
  title: string;
  source: string;
  width: number;
  height: number;
  description: string;
}

function extractImages(data: SerperResponse): EnrichedImage[] {
  return (data.images ?? []).map((img) => ({
    url: img.imageUrl,
    title: img.title ?? "",
    source: img.link ?? "",
    width: img.imageWidth ?? 0,
    height: img.imageHeight ?? 0,
    description: "",
  }));
}

async function describeImage(
  replicate: Replicate,
  imageUrl: string,
): Promise<string> {
  try {
    const res = await fetch(imageUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS),
      redirect: "follow",
    });

    if (!res.ok) return "";
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) return "";

    const imageBytes = await res.arrayBuffer();
    const b64 = Buffer.from(imageBytes).toString("base64");
    const dataUrl = `data:${contentType};base64,${b64}`;

    const output: unknown = await replicate.run(MOONDREAM_MODEL, {
      input: { image: dataUrl, prompt: MOONDREAM_PROMPT },
    });

    if (typeof output === "string") return output.trim();
    if (output && typeof output === "object" && Symbol.iterator in output) {
      return Array.from(output as Iterable<unknown>)
        .map(String)
        .join("")
        .trim();
    }
    return "";
  } catch {
    return "";
  }
}

async function enrichImages(images: EnrichedImage[]): Promise<EnrichedImage[]> {
  const replicateBaseUrl = getEnv("REPLICATE_API_URL");
  // When routed through the Kortix proxy (REPLICATE_API_URL is set), use KORTIX_TOKEN
  // for auth — the proxy validates it and injects the real Replicate API token.
  const replicateToken = replicateBaseUrl
    ? getEnv("KORTIX_TOKEN")
    : getEnv("REPLICATE_API_TOKEN");
  if (!replicateToken || images.length === 0) return images;

  const replicate = new Replicate({
    auth: replicateToken,
    ...(replicateBaseUrl ? { baseUrl: replicateBaseUrl } : {}),
  });

  return Promise.all(
    images.map(async (img) => {
      try {
        const description = await describeImage(replicate, img.url);
        return { ...img, description: description || img.description };
      } catch {
        return img;
      }
    }),
  );
}

export default tool({
  description:
    "Search for images using the Serper Google Images API. " +
    "Returns image URLs with titles, source pages, dimensions, and AI-generated descriptions. " +
    "When REPLICATE_API_TOKEN is set, enriches results with Moondream2 vision descriptions. " +
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
    enrich: tool.schema
      .boolean()
      .optional()
      .describe(
        "Enrich images with AI descriptions via Moondream2. Requires REPLICATE_API_TOKEN. Default: true",
      ),
  },
  async execute(args, _context) {
    const serperUrlOverride = getEnv("SERPER_API_URL");
    // When routed through the Kortix proxy (SERPER_API_URL is set), use KORTIX_TOKEN
    // for auth — the proxy validates it and injects the real Serper API key.
    const apiKey = serperUrlOverride
      ? getEnv("KORTIX_TOKEN")
      : getEnv("SERPER_API_KEY");
    if (!apiKey) return serperUrlOverride
      ? "Error: KORTIX_TOKEN not set."
      : "Error: SERPER_API_KEY not set.";

    const numResults = Math.max(1, Math.min(args.num_results ?? 12, 100));
    const shouldEnrich = args.enrich !== false;
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
        let images = extractImages(data);

        if (images.length === 0) return `No images found for: '${queries[0]}'`;
        if (shouldEnrich) images = await enrichImages(images);

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
          let images = extractImages(d);
          if (shouldEnrich) images = await enrichImages(images);
          return { query: queries[i], total: images.length, images };
        }),
      );

      return JSON.stringify({ batch_mode: true, results }, null, 2);
    } catch (e) {
      return `Error: ${String(e)}`;
    }
  },
});
