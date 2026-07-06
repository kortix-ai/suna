---
name: people-search
description: "Find people — track down a specific person, or assemble a shortlist who match a profile (title + industry + geography + skill). Use to locate a named individual, build a sourcing/recruiting/outreach list, or answer 'who is the X at Y' / 'find people who Z'. Backed by the people_search tool (LinkedIn profile search → structured profiles)."
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

- **entity-search** — richer, connector-backed people/company lookup (verified emails, org charts) when a people-data connector is configured.
- **account-research** — full picture of a company or person before outreach.
- **deep-research** — multi-source, fact-checked report when the question is broader than "who."
