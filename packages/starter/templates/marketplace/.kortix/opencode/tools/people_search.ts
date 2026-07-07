import { tool } from "@opencode-ai/plugin";
import { getEnv, getKortixRouterBase } from "./lib/get-env";

// People search is powered by an Apify LinkedIn-profile-search actor. Like
// web_search, it runs in two modes: through the Kortix router by default (Kortix
// injects the APIFY_TOKEN and bills the account — zero config for the user), or
// against a raw APIFY_TOKEN when KORTIX_API_URL is unset (self-host / opt-in).
//
// The search is an Apify actor "run" (not an instant API). We use the
// run-sync-get-dataset-items endpoint in "Short" mode (search pages only, no
// per-profile open) — the fastest, cheapest path (~$0.10 per 25) — and wait for
// it to finish. A run can take a while; that's expected, let it complete.

const ACTOR = "harvestapi~linkedin-profile-search";
const RUN_PATH = `/v2/acts/${ACTOR}/run-sync-get-dataset-items`;
const APIFY_DIRECT_BASE = "https://api.apify.com";

interface RawPerson {
  name?: string;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  headline?: string;
  title?: string;
  occupation?: string;
  location?: string;
  locationName?: string;
  linkedinUrl?: string;
  profileUrl?: string;
  url?: string;
  publicProfileUrl?: string;
  companyName?: string;
  currentCompany?: { name?: string } | null;
  currentPosition?: { companyName?: string; title?: string } | null;
  experience?: Array<{ companyName?: string; title?: string }>;
  email?: string | null;
}

function splitList(v?: string): string[] | undefined {
  if (!v) return undefined;
  const items = v.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

function formatPerson(p: RawPerson) {
  return {
    name: p.name || p.fullName || [p.firstName, p.lastName].filter(Boolean).join(" ").trim(),
    title: p.headline || p.title || p.occupation || p.currentPosition?.title || "",
    company:
      p.companyName ||
      p.currentPosition?.companyName ||
      p.currentCompany?.name ||
      p.experience?.[0]?.companyName ||
      "",
    location: p.location || p.locationName || "",
    linkedin_url: p.linkedinUrl || p.profileUrl || p.publicProfileUrl || p.url || "",
    email: p.email ?? null,
  };
}

export default tool({
  description:
    "Find real people by profile — name, title, company, location, or skill — via LinkedIn profile search. " +
    "Returns structured profiles (name, title, current company, location, LinkedIn URL). " +
    "Use for sourcing / recruiting / outreach lists and named-person lookups. " +
    "Always hyperlink each person's name to their LinkedIn URL in the result.",
  args: {
    query: tool.schema
      .string()
      .describe("Free-text search: name, role, focus, or keywords (e.g. 'climate tech founder')."),
    titles: tool.schema
      .string()
      .optional()
      .describe("Comma-separated current job titles to match (e.g. 'Head of Talent,Recruiting Lead')."),
    locations: tool.schema
      .string()
      .optional()
      .describe("Comma-separated locations — city / region / country (e.g. 'Singapore')."),
    num_results: tool.schema
      .number()
      .optional()
      .describe("People to return (1-25). Default: 10"),
  },
  async execute(args, _context) {
    const routerBase = getKortixRouterBase("apify");
    const kortixToken = getEnv("KORTIX_TOKEN");
    const apifyToken = getEnv("APIFY_TOKEN");

    let url: string;
    let bearer: string;
    if (routerBase && kortixToken) {
      url = `${routerBase}${RUN_PATH}`;
      bearer = kortixToken; // the router validates this and injects the real APIFY_TOKEN
    } else if (apifyToken) {
      url = `${APIFY_DIRECT_BASE}${RUN_PATH}`;
      bearer = apifyToken;
    } else {
      return JSON.stringify(
        {
          success: false,
          error:
            "people_search is unavailable: no Kortix router (KORTIX_API_URL / KORTIX_TOKEN) and no APIFY_TOKEN set.",
        },
        null,
        2,
      );
    }

    const maxItems = Math.max(1, Math.min(args.num_results ?? 10, 25));
    const input: Record<string, unknown> = {
      profileScraperMode: "Short",
      searchQuery: args.query,
      maxItems,
    };
    const titles = splitList(args.titles);
    if (titles) input.currentJobTitles = titles;
    const locations = splitList(args.locations);
    if (locations) input.locations = locations;

    try {
      const res = await fetch(`${url}?maxItems=${maxItems}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return JSON.stringify(
          { success: false, error: `people_search API error: ${res.status} ${text.slice(0, 300)}` },
          null,
          2,
        );
      }
      const data = (await res.json()) as RawPerson[] | { items?: RawPerson[] };
      const items = Array.isArray(data) ? data : (data.items ?? []);
      const results = items.map(formatPerson).filter((p) => p.name);
      return JSON.stringify(
        { success: true, query: args.query, count: results.length, results },
        null,
        2,
      );
    } catch (e) {
      return JSON.stringify({ success: false, error: String(e) }, null, 2);
    }
  },
});
