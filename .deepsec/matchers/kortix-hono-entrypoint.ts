import type { CandidateMatch, MatcherPlugin } from "deepsec/config";

const ROUTE_RE =
  /\b(?:app|router|projectsApp|projectWebhooksApp|kortixRouter|setupLinksPublicApp|oauthApp|tunnelApp|executorApp|adminApp|opsApp|scimRouter|accountsRouter|accountInvitesRouter|sandboxProxyApp|webProxyRouter)\s*\.\s*(?:get|post|put|patch|delete|all|route|openapi|use)\s*\(/;

export const kortixHonoEntrypoint: MatcherPlugin = {
  slug: "kortix-hono-entrypoint",
  description: "Kortix Hono/OpenAPI route and middleware entry points for auth/proxy review",
  noiseTier: "noisy",
  filePatterns: [
    "apps/api/src/**/*.ts",
    "apps/kortix-sandbox-agent-server/src/**/*.ts",
  ],
  match(content, filePath): CandidateMatch[] {
    if (/\.(test|spec)\.ts$/.test(filePath) || filePath.includes("/__tests__/")) return [];
    if (!/(Hono|OpenAPIHono|makeOpenApiApp|\.openapi\s*\(|\.route\s*\(|\.use\s*\()/.test(content)) return [];

    const lines = content.split("\n");
    const matches: CandidateMatch[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!ROUTE_RE.test(lines[i])) continue;
      const start = Math.max(0, i - 2);
      const end = Math.min(lines.length, i + 8);
      matches.push({
        vulnSlug: "kortix-hono-entrypoint",
        lineNumbers: [i + 1],
        snippet: lines.slice(start, end).join("\n"),
        matchedPattern: "Kortix Hono/OpenAPI route or middleware registration",
      });
    }
    return matches;
  },
};
