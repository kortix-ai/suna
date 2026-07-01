import { createRoute, z } from "@hono/zod-openapi";
import { Effect, Schema } from "effect";
import type { AppEnv } from "../../types";
import { makeOpenApiApp, json } from "../../openapi";
import { platformConfig as config, platformFetch } from "../effect";
import { runHttpEffect } from "../../effect/http";
import { effectHandler } from "../../effect/hono";

/**
 * Sandbox version and changelog endpoints.
 *
 * Sources of truth:
 * - Running version: SANDBOX_VERSION, injected at container start.
 * - Stable releases: GitHub Releases API.
 * - Dev builds: Docker Hub tags for kortix/kortix-sandbox.
 */

const GITHUB_REPO = "kortix-ai/suna";
const GITHUB_API_BASE = "https://api.github.com";
const DOCKERHUB_REPO = "kortix/kortix-sandbox";
const DOCKERHUB_TAGS_URL = `https://hub.docker.com/v2/repositories/${DOCKERHUB_REPO}/tags`;
const CACHE_TTL_MS = 5 * 60 * 1000;

type VersionChannel = "stable" | "dev";

interface VersionEntry {
  version: string;
  channel: VersionChannel;
  date: string;
  title: string;
  body?: string;
  sha?: string;
  current: boolean;
}

interface LatestVersionResult {
  version: string;
  channel: VersionChannel;
  date?: string;
  title?: string;
  sha?: string;
}

interface DockerHubTag {
  name: string;
  last_updated: string;
}

interface GHRelease {
  tag_name: string;
  name: string;
  published_at: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
}

const DockerHubTagSchema = Schema.Struct({
  name: Schema.String,
  last_updated: Schema.String,
});

const DockerHubTagsResponseSchema = Schema.Struct({
  results: Schema.Array(DockerHubTagSchema),
});

const GHReleaseSchema = Schema.Struct({
  tag_name: Schema.String,
  name: Schema.String,
  published_at: Schema.String,
  body: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
});

interface CacheEntry<T> {
  data: T;
  cachedAt: number;
}

const cache: {
  latestStable: CacheEntry<LatestVersionResult> | null;
  latestDev: CacheEntry<LatestVersionResult> | null;
  allVersions: CacheEntry<VersionEntry[]> | null;
} = {
  latestStable: null,
  latestDev: null,
  allVersions: null,
};

function isCacheValid<T>(entry: CacheEntry<T> | null): entry is CacheEntry<T> {
  return entry !== null && Date.now() - entry.cachedAt < CACHE_TTL_MS;
}

function getRunningVersion(): string {
  return (
    process.env.SANDBOX_VERSION || config.SANDBOX_VERSION_OVERRIDE || "unknown"
  );
}

function getRunningChannel(): VersionChannel {
  return detectVersionChannel(getRunningVersion());
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (config.GITHUB_TOKEN)
    headers.Authorization = `Bearer ${config.GITHUB_TOKEN}`;
  return headers;
}

const fetchJsonEffect = (url: string, init: RequestInit, label: string) =>
  Effect.gen(function* () {
    const res = yield* Effect.tryPromise({
      try: () => platformFetch(url, init),
      catch: (cause) => new Error(`${label} request failed: ${String(cause)}`),
    });
    if (!res.ok) {
      return yield* Effect.fail(new Error(`${label} failed: ${res.status}`));
    }
    return yield* Effect.tryPromise({
      try: () => res.json(),
      catch: (cause) =>
        new Error(`${label} returned invalid JSON: ${String(cause)}`),
    });
  });

function fetchStableReleasesEffect(limit = 20): Effect.Effect<GHRelease[]> {
  const path = `/repos/${GITHUB_REPO}/releases?per_page=${limit}`;
  return fetchJsonEffect(
    `${GITHUB_API_BASE}${path}`,
    {
      headers: githubHeaders(),
      signal: AbortSignal.timeout(8_000),
    },
    `GitHub API ${path}`,
  ).pipe(
    Effect.flatMap(Schema.decodeUnknown(Schema.Array(GHReleaseSchema))),
    Effect.map((releases) => releases.filter((release) => !release.draft)),
    Effect.catchAll((err) =>
      Effect.sync(() => {
        console.warn("[version] Failed to fetch GitHub releases:", err);
        return [];
      }),
    ),
  );
}

function fetchDockerHubDevTagsEffect(
  limit = 20,
): Effect.Effect<DockerHubTag[]> {
  return fetchJsonEffect(
    `${DOCKERHUB_TAGS_URL}/?page_size=100&ordering=last_updated`,
    { signal: AbortSignal.timeout(8_000) },
    "Docker Hub API",
  ).pipe(
    Effect.flatMap(Schema.decodeUnknown(DockerHubTagsResponseSchema)),
    Effect.map((data) =>
      (data.results || [])
        .filter((tag) => {
          if (!tag.name.startsWith("dev-")) return false;
          if (tag.name === "dev-latest") return false;
          if (tag.name.endsWith("-amd64") || tag.name.endsWith("-arm64"))
            return false;
          return true;
        })
        .slice(0, limit),
    ),
    Effect.catchAll((err) =>
      Effect.sync(() => {
        console.warn("[version] Failed to fetch Docker Hub dev tags:", err);
        return [];
      }),
    ),
  );
}

function getLatestStableEffect(): Effect.Effect<LatestVersionResult> {
  if (isCacheValid(cache.latestStable))
    return Effect.succeed(cache.latestStable.data);

  return Effect.gen(function* () {
    const releases = yield* fetchStableReleasesEffect(1);
    if (releases.length > 0) {
      const release = releases[0];
      const version = release.tag_name.replace(/^v/, "");
      const result: LatestVersionResult = {
        version,
        channel: "stable",
        date: release.published_at?.split("T")[0],
        title: release.name || `v${version}`,
      };
      cache.latestStable = { data: result, cachedAt: Date.now() };
      return result;
    }

    return {
      version: "unknown",
      channel: "stable",
      title: "No stable release available",
    };
  });
}

function getLatestDevEffect(): Effect.Effect<LatestVersionResult> {
  if (isCacheValid(cache.latestDev))
    return Effect.succeed(cache.latestDev.data);

  return Effect.gen(function* () {
    const tags = yield* fetchDockerHubDevTagsEffect(1);
    if (tags.length > 0) {
      const tag = tags[0];
      const sha8 = tag.name.replace("dev-", "");
      const result: LatestVersionResult = {
        version: tag.name,
        channel: "dev",
        date: tag.last_updated?.split("T")[0],
        title: `Dev build ${sha8}`,
        sha: sha8,
      };
      cache.latestDev = { data: result, cachedAt: Date.now() };
      return result;
    }

    const running = getRunningVersion();
    return {
      version: running.startsWith("dev-") ? running : "dev-unknown",
      channel: "dev",
      title: "No dev build available",
    };
  });
}

function getAllVersionsEffect(): Effect.Effect<VersionEntry[]> {
  if (isCacheValid(cache.allVersions))
    return Effect.succeed(cache.allVersions.data);

  return Effect.gen(function* () {
    const runningVersion = getRunningVersion();
    const versions: VersionEntry[] = [];

    const releases = yield* fetchStableReleasesEffect(20);
    for (const release of releases) {
      const version = release.tag_name.replace(/^v/, "");
      versions.push({
        version,
        channel: release.prerelease ? "dev" : "stable",
        date: release.published_at?.split("T")[0] ?? "",
        title: release.name || `v${version}`,
        body: release.body || undefined,
        current: version === runningVersion,
      });
    }

    const devTags = yield* fetchDockerHubDevTagsEffect(20);
    for (const tag of devTags) {
      const sha8 = tag.name.replace("dev-", "");
      versions.push({
        version: tag.name,
        channel: "dev",
        date: tag.last_updated?.split("T")[0] ?? "",
        title: `Dev build ${sha8}`,
        sha: sha8,
        current: tag.name === runningVersion,
      });
    }

    versions.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
    cache.allVersions = { data: versions, cachedAt: Date.now() };
    return versions;
  });
}

const ChannelSchema = z.enum(["stable", "dev"]);

const RunningVersionSchema = z
  .object({
    version: z.string(),
    channel: ChannelSchema,
  })
  .openapi("SandboxRunningVersion");

const LatestVersionSchema = z
  .object({
    version: z.string(),
    channel: ChannelSchema,
    date: z.string().optional(),
    title: z.string().optional(),
    sha: z.string().optional(),
  })
  .openapi("SandboxLatestVersion");

const VersionEntrySchema = z
  .object({
    version: z.string(),
    channel: ChannelSchema,
    date: z.string(),
    title: z.string(),
    body: z.string().optional(),
    sha: z.string().optional(),
    current: z.boolean(),
  })
  .openapi("SandboxVersionEntry");

const AllVersionsSchema = z
  .object({
    versions: z.array(VersionEntrySchema),
    current: RunningVersionSchema,
  })
  .openapi("SandboxAllVersions");

// Entries are assembled as `Record<string, unknown>` (version/channel/date/title/
// description/changes, plus `sha` on dev). Keep the schema permissive so it
// documents the surface without constraining the opaque map the handler returns.
const ChangelogEntrySchema = z
  .record(z.string(), z.unknown())
  .openapi("SandboxChangelogEntry");

const ChangelogSchema = z
  .object({ changelog: z.array(ChangelogEntrySchema) })
  .openapi("SandboxChangelog");

const versionRouter = makeOpenApiApp<AppEnv>();

versionRouter.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["platform"],
    summary: "Running sandbox version and channel",
    responses: {
      200: json(
        RunningVersionSchema,
        "The sandbox version this server is running",
      ),
    },
  }),
  effectHandler((c) => {
    return c.json({
      version: getRunningVersion(),
      channel: getRunningChannel(),
    });
  }),
);

versionRouter.openapi(
  createRoute({
    method: "get",
    path: "/latest",
    tags: ["platform"],
    summary: "Latest available sandbox version for a channel",
    request: {
      query: z.object({ channel: ChannelSchema.optional() }),
    },
    responses: {
      200: json(
        LatestVersionSchema,
        "Latest version for the requested channel (stable by default)",
      ),
    },
  }),
  async (c) => {
    const channel = (c.req.query("channel") || "stable") as VersionChannel;
    const latest = await runHttpEffect(
      channel === "dev" ? getLatestDevEffect() : getLatestStableEffect(),
    );
    return c.json(latest);
  },
);

versionRouter.openapi(
  createRoute({
    method: "get",
    path: "/all",
    tags: ["platform"],
    summary: "All known sandbox versions plus the current running version",
    responses: {
      200: json(
        AllVersionsSchema,
        "All versions across channels and the current running version",
      ),
    },
  }),
  async (c) => {
    const versions = await runHttpEffect(getAllVersionsEffect());
    return c.json({
      versions,
      current: {
        version: getRunningVersion(),
        channel: getRunningChannel(),
      },
    });
  },
);

versionRouter.openapi(
  createRoute({
    method: "get",
    path: "/changelog",
    tags: ["platform"],
    summary: "Sandbox changelog entries for a channel",
    request: {
      query: z.object({ channel: z.string().optional() }),
    },
    responses: {
      200: json(ChangelogSchema, "Changelog entries (stable, dev, or all)"),
    },
  }),
  async (c) => {
    const channel = c.req.query("channel") || "all";
    const changelog = await runHttpEffect(
      Effect.gen(function* () {
        const entries: Array<Record<string, unknown>> = [];

        if (channel === "stable" || channel === "all") {
          const releases = yield* fetchStableReleasesEffect(20);
          for (const release of releases) {
            if (release.prerelease) continue;
            const version = release.tag_name.replace(/^v/, "");
            entries.push({
              version,
              channel: "stable",
              date: release.published_at?.split("T")[0] ?? "",
              title: release.name || `v${version}`,
              description: release.body || "",
              changes: [],
            });
          }
        }

        if (channel === "dev" || channel === "all") {
          const devTags = yield* fetchDockerHubDevTagsEffect(20);
          for (const tag of devTags) {
            const sha8 = tag.name.replace("dev-", "");
            entries.push({
              version: tag.name,
              channel: "dev",
              date: tag.last_updated?.split("T")[0] ?? "",
              title: `Dev build ${sha8}`,
              description: "",
              changes: [],
              sha: sha8,
            });
          }
        }

        entries.sort((a, b) =>
          String(b.date ?? "").localeCompare(String(a.date ?? "")),
        );
        return entries;
      }),
    );
    return c.json({ changelog });
  },
);

export { versionRouter };

function detectVersionChannel(
  version: string | null | undefined,
): VersionChannel {
  return version?.startsWith("dev-") ? "dev" : "stable";
}
