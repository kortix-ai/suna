import { tool } from "@opencode-ai/plugin";
import { getEnv, getKortixRouterBase } from "./lib/get-env";

// People data is fetched from a people-search provider (Apollo). Like web_search,
// this runs in two modes: through the Kortix router by default (Kortix injects the
// upstream key and bills the account — zero config for the user), or against a raw
// APOLLO_API_KEY when KORTIX_API_URL is unset (self-host / opt-in to your own plan).

interface ApolloPerson {
  id?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  title?: string;
  headline?: string;
  linkedin_url?: string;
  email?: string | null;
  city?: string;
  state?: string;
  country?: string;
  organization?: { name?: string; website_url?: string } | null;
}

interface ApolloResponse {
  people?: ApolloPerson[];
  pagination?: { page?: number; per_page?: number; total_entries?: number };
}

const APOLLO_DIRECT_BASE = "https://api.apollo.io";
const SEARCH_PATH = "/api/v1/mixed_people/search";

function splitList(v?: string): string[] | undefined {
  if (!v) return undefined;
  const items = v.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

function formatPerson(p: ApolloPerson) {
  const location = [p.city, p.state, p.country].filter(Boolean).join(", ");
  return {
    name: p.name ?? [p.first_name, p.last_name].filter(Boolean).join(" ").trim(),
    title: p.title ?? p.headline ?? "",
    company: p.organization?.name ?? "",
    location,
    linkedin_url: p.linkedin_url ?? "",
    email: p.email ?? null,
  };
}

export default tool({
  description:
    "Find real people by profile — name, title, company, location, or skill — from a people-data index. " +
    "Returns structured profiles (name, title, current company, location, LinkedIn URL), cleaner than scraping the open web. " +
    "Use for sourcing / recruiting / outreach lists and named-person lookups. " +
    "Always hyperlink each person's name to their LinkedIn/source URL in the result.",
  args: {
    query: tool.schema
      .string()
      .describe("Free-text keywords: name, focus, skills, or industry (e.g. 'climate tech founder')."),
    titles: tool.schema
      .string()
      .optional()
      .describe("Comma-separated job titles to match (e.g. 'Head of Talent,Recruiting Lead')."),
    locations: tool.schema
      .string()
      .optional()
      .describe("Comma-separated person locations — city / region / country (e.g. 'Singapore')."),
    num_results: tool.schema
      .number()
      .optional()
      .describe("People to return (1-25). Default: 10"),
    page: tool.schema
      .number()
      .optional()
      .describe("Page number for pagination (default 1)."),
  },
  async execute(args, _context) {
    const routerBase = getKortixRouterBase("apollo");
    const kortixToken = getEnv("KORTIX_TOKEN");
    const apolloKey = getEnv("APOLLO_API_KEY");

    let url: string;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    };
    if (routerBase && kortixToken) {
      url = `${routerBase}${SEARCH_PATH}`;
      headers["Authorization"] = `Bearer ${kortixToken}`;
    } else if (apolloKey) {
      url = `${APOLLO_DIRECT_BASE}${SEARCH_PATH}`;
      headers["X-Api-Key"] = apolloKey;
    } else {
      return JSON.stringify(
        {
          success: false,
          error:
            "people_search is unavailable: no Kortix router (KORTIX_API_URL / KORTIX_TOKEN) and no APOLLO_API_KEY set. Fall back to the web_search + scrape_webpage pipeline for people lookup.",
        },
        null,
        2,
      );
    }

    const perPage = Math.max(1, Math.min(args.num_results ?? 10, 25));
    const body: Record<string, unknown> = {
      q_keywords: args.query,
      page: Math.max(1, args.page ?? 1),
      per_page: perPage,
    };
    const titles = splitList(args.titles);
    if (titles) body.person_titles = titles;
    const locations = splitList(args.locations);
    if (locations) body.person_locations = locations;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return JSON.stringify(
          { success: false, error: `people_search API error: ${res.status} ${text.slice(0, 300)}` },
          null,
          2,
        );
      }
      const data = (await res.json()) as ApolloResponse;
      const people = (data.people ?? []).map(formatPerson);
      return JSON.stringify(
        {
          success: true,
          query: args.query,
          total: data.pagination?.total_entries ?? people.length,
          page: data.pagination?.page ?? body.page,
          count: people.length,
          results: people,
        },
        null,
        2,
      );
    } catch (e) {
      return JSON.stringify({ success: false, error: String(e) }, null, 2);
    }
  },
});
