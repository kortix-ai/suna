import { tool } from "./lib/tool";
import { getEnv, getKortixRouterBase } from "./lib/get-env";

const SERPER_DEFAULT_URL = "https://google.serper.dev";
const REPLICATE_DEFAULT_URL = "https://api.replicate.com/v1";
const REPLICATE_POLL_INTERVAL_MS = 500;
const REPLICATE_TIMEOUT_MS = 120_000;

function getSerperImagesUrl(): string {
  const override = getKortixRouterBase("serper");
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

interface ReplicatePrediction {
  id?: string;
  status?: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output?: unknown;
  error?: unknown;
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
  replicateBaseURL: string,
  replicateToken: string,
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

    const version = MOONDREAM_MODEL.split(":", 2)[1]!;
    const headers = {
      Authorization: `Bearer ${replicateToken}`,
      "Content-Type": "application/json",
      Prefer: "wait",
    };
    const baseURL = replicateBaseURL.replace(/\/+$/, "");
    const created = await fetch(`${baseURL}/predictions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        version,
        input: { image: dataUrl, prompt: MOONDREAM_PROMPT },
      }),
      signal: AbortSignal.timeout(REPLICATE_TIMEOUT_MS),
    });
    const createdText = await created.text();
    if (!created.ok) throw new Error(`${created.status} Error: ${createdText}`);
    let prediction = JSON.parse(createdText) as ReplicatePrediction;

    const deadline = Date.now() + REPLICATE_TIMEOUT_MS;
    while (
      prediction.status !== "succeeded" &&
      prediction.status !== "failed" &&
      prediction.status !== "canceled"
    ) {
      if (!prediction.id || Date.now() >= deadline) {
        throw new Error("Replicate prediction timed out");
      }
      await new Promise((resolve) => setTimeout(resolve, REPLICATE_POLL_INTERVAL_MS));
      const polled = await fetch(`${baseURL}/predictions/${prediction.id}`, {
        headers: { Authorization: `Bearer ${replicateToken}` },
        signal: AbortSignal.timeout(REPLICATE_TIMEOUT_MS),
      });
      const polledText = await polled.text();
      if (!polled.ok) throw new Error(`${polled.status} Error: ${polledText}`);
      prediction = JSON.parse(polledText) as ReplicatePrediction;
    }
    if (prediction.status !== "succeeded") {
      throw new Error(`Prediction ${prediction.status}: ${String(prediction.error ?? "")}`);
    }
    const output = prediction.output;

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
  const replicateRouterBaseURL = getKortixRouterBase("replicate");
  const replicateBaseURL = replicateRouterBaseURL ?? REPLICATE_DEFAULT_URL;
  // Route through the Kortix router (derived from KORTIX_API_URL); auth with
  // KORTIX_SANDBOX_TOKEN (KORTIX_TOKEN kept as a legacy fallback). Fall back
  // to a raw REPLICATE_API_TOKEN only when unset.
  const replicateToken = replicateRouterBaseURL
    ? getEnv("KORTIX_SANDBOX_TOKEN") || getEnv("KORTIX_TOKEN")
    : getEnv("REPLICATE_API_TOKEN");
  if (!replicateToken || images.length === 0) return images;

  return Promise.all(
    images.map(async (img) => {
      try {
        const description = await describeImage(
          replicateBaseURL,
          replicateToken,
          img.url,
        );
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
