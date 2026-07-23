---
name: people-search
description: "Find people and companies — track down a specific person, assemble a shortlist who match a profile (title + industry + geography + skill), or look up a company/account. Use to locate a named individual, build a sourcing/recruiting/outreach list, resolve a company's org chart or firmographics, or answer 'who is the X at Y' / 'find people who Z' / 'look up this company'. Backed by the people_search tool (LinkedIn profile search → structured profiles) for the default web path, and by a connected people-data connector (Apollo, People Data Labs, Clearbit, Clay, RocketReach, Hunter, Lusha, ZoomInfo) for verified, richer records and company-level data when one is available."
---

# People Search

Find people — a single named person, or a whole list that fits a profile — with the **`people_search`** tool. It runs a LinkedIn profile search and returns **structured profiles**: name, title, current company, location, and LinkedIn URL. It works out of the box (Kortix-proxied, billed to the account) or with your own `APIFY_TOKEN`.

## Using the tool

```
people_search(query="climate tech founder", titles="Founder,CEO", locations="Lagos", num_results=10)
```

- `query` — free-text: name, role, focus, or keywords. This is the main lever.
- `titles` — comma-separated current job titles to match (e.g. `"Head of Talent,Recruiting Lead"`).
- `locations` — comma-separated city / region / country (e.g. `"Singapore"`).
- `num_results` — 1–25 (default 10).

Each result is `{ name, title, company, location, linkedin_url, email }`. The search is a real run, so it can take a little while — let it finish.

### Get the query right

The result is mostly as good as the `query` + filters:

- **Spell out and abbreviate the role** when it helps — "developer relations" vs "DevRel"; "Head of Talent" vs "recruiting lead".
- **Anchor with what you know** — company, city, school, seniority, a distinctive skill. More anchors → cleaner results.
- **One person?** Put the name in `query` (add company/location if you have them) and keep `num_results` low.
- **A list?** Lead with `titles` + `locations` and a focused `query`; raise `num_results`.

## Refine the results

`people_search` returns people who match — tighten before you deliver:

1. **Filter to true matches.** Judge each person against the real criteria, phrased as exclusions ("drop anyone NOT currently a Head of Talent, NOT at a fintech, NOT in Singapore"). Note in one line *why* each kept person qualifies.
2. **Enrich when you need depth.** The profiles are concise (title / company / location). For bio, work history, education, or projects, `scrape_webpage` the person's `linkedin_url` or another public page (personal site, company team page, conference bio, Crunchbase). LinkedIn itself is often gated — corroborate from a second public source when it is.

## Output format

For a **named lookup or dossier**:

```markdown
# [Full Name] — [Current Title], [Company]

**Profile:** [LinkedIn link]

## Snapshot
[2–3 sentences: who they are, what they're known for, current focus.]

## Background
| Field | Detail |
|-------|--------|
| **Current role** | [Title at Company] |
| **Location** | [City / region] |
| **Previously** | [Notable prior roles] |
| **Education** | [Institutions] |
| **Focus / skills** | [Areas, specialties] |

## Sources
- [Source 1](URL)
```

For a **candidate list**, link each name to their profile, one row per match:

```markdown
# [Search description] — [N] matches

| Person | Role & Company | Location | Why they match |
|--------|----------------|----------|----------------|
| [Amara Okafor](https://…) | Founder, GreenGrid (climate tech) | Lagos | Series-seed climate startup; ex-Tesla energy |
| [Wei Chen](https://…) | Head of Talent, Paywave | Singapore | Leads TA at a fintech, 3 yrs in role |
```

## Richer Lookup: When a People-Data Connector Is Connected

The web path above (`people_search`) works standalone and covers most asks. If the project also has a people-data connector wired up — an enrichment, prospecting, or contact-data provider such as Apollo, People Data Labs, Clearbit, Clay, RocketReach, Hunter, Lusha, or ZoomInfo — prefer it when precision and verified fields matter, or for company-level lookups the web tool doesn't cover.

**Check what's connected:**
```sh
kortix executor connectors          # or the `connectors` MCP tool
```
A connector qualifies if its job is people/company data. (CRMs like Salesforce/HubSpot can enrich *known* contacts too, but don't discover new ones — treat them as a supplement.) Nothing connected → stay on the web path above; it already answers most asks, and it's fine to offer to wire one up without blocking the request.

**Two operations cover almost everything** once a connector is live — exact action names vary per provider, so inspect its tool schema and pick the closest match:

1. **Find / shortlist** — the connector's people-search or prospect-search action takes structured filters (title, company, location, seniority, headcount, industry) and returns candidates from a curated index. Fan out the same way as the web path: vary title wording and scope across a few calls, then merge by a stable key (profile URL or provider person-id). Coverage is cleaner than a web sweep but not exhaustive — a miss is not proof the person doesn't exist; fall back to the web path for the gaps.
2. **Enrich** — the connector's enrich / profile-lookup action resolves a known identifier (name+company, email, domain, or profile URL) into a fielded record: verified email, phone, employment history, education, org chart. This is the high-value path for turning a list into clean rows with no scraping. Batch where the action supports it; respect per-call ceilings and credit budget.

**Company lookup.** For account-level questions — firmographics, headcount, org chart, tech stack, funding — most people-data connectors expose a company/organization-search or company-enrich action alongside the people actions. Use it the same way: search by domain or name, enrich into a fielded company record. Without a connector, get company facts from the web path (`web_search` + `scrape_webpage` on the company site, LinkedIn company page, Crunchbase) or hand off to `account-research` for a full company dossier.

**Filter — same discipline as the web path.** A curated index still returns loose matches. Phrase criteria as exclusions and judge each candidate against the fielded data returned; don't skip this step just because the connector felt more authoritative.

**Wiring up a connector (when none exists).** Don't send the user to a dashboard — use the credentials flow (`kortix-system` → *Credentials & setup links*):
- Pipedream-backed app (most prospecting tools): `kortix executor add apollo --provider pipedream --app apollo`, then `kortix executor connect apollo` to mint a 1-click link.
- API-key provider (e.g. a People Data Labs key): `kortix secrets request PDL_API_KEY --scope connector`.

Surface the URL, end your turn, and verify it landed (`kortix executor connectors` / `kortix secrets ls`) when the user returns.

**Output differences on the connector path:**
- Source line names the connector, not "Web Search" — `**Found via:** Apollo`.
- Verified-contact fields carry through — label an email that came from the connector `email_verified: true`. Anything not returned by the connector stays absent or `email_verified: false`. Never fabricate or pattern-guess, on either path.
- Respect compliance gating — if an action returns a permission/region error, surface it plainly rather than working around it.

## Gotchas

- **The name *is* the link.** Hyperlink each person's `linkedin_url` on their name — `[Amara Okafor](https://…) — Founder, GreenGrid`. Never a bare name or a trailing raw URL. For CSV (no markdown), keep a `profile_url` column.
- **Never invent emails.** If `email` is null, leave it out or mark `email_verified: false`. Never pattern-guess `first.last@company.com`.
- **Corroborate moves.** Titles and companies change. For a high-stakes claim, confirm the current role from the profile or a second source.
- **Gated profiles.** LinkedIn pages often block scraping — lean on the structured fields `people_search` already returned and corroborate elsewhere instead of fighting the login wall.
- **Results count ≠ matches.** `num_results=25` returns up to 25 candidates, not 25 perfect fits — the filter step produces the real number.

## Tips

1. **Give anchors** — company, city, school, "spoke at X" — they cut noise sharply.
2. **Name the real criteria** so the filter step can do its job.
3. **State the goal** — a recruiting shortlist, an outreach list, and a single dossier need different depth.

## Related skills

- **account-research** — full picture of a company or person before outreach.
- **deep-research** — multi-source, fact-checked report when the question is broader than "who."
