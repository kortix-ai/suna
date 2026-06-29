---
name: people-search
description: "Find people through web research — track down a specific person, or assemble a shortlist of people who match a profile (title + industry + geography + skill). Use to locate a named individual, build a sourcing/recruiting/outreach list, enrich a known contact into a dossier, or answer 'who is the X at Y' / 'find people who Z'. Web-search-backed: wide reach, then filtered down to precise matches."
defaultProjectInstall: true
---

# People Search

<!--
  This skill runs entirely on web search + page scraping — there is no dedicated
  people index behind it. That means broad recall but noisier results, so the
  filter step carries the precision. A richer, connector-backed version
  (verified profiles, emails, org charts) can supersede this one later; until
  then, this is the default. Be honest about the noise and lean on filtering.
-->

Find people on the open web — a single named person, or a whole list that fits a
profile. I fan out a set of varied searches, merge and de-duplicate what comes
back, scrape the promising pages to fill in detail, then ruthlessly filter down
to the people who actually match before handing you a clean, sourced result.

## How It Works

```
┌──────────────────────────────────────────────────────────────────┐
│                        PEOPLE SEARCH                              │
├──────────────────────────────────────────────────────────────────┤
│  1. FAN OUT      Several varied web_search queries, not one       │
│                  (name+company · role+location · "<name>" bio …)  │
│  2. MERGE        Collect hits, de-dupe by URL, keep richest text  │
│  3. ENRICH       scrape_webpage the strongest candidate pages     │
│  4. FILTER       Keep only true matches — criteria as exclusions  │
│  5. DOSSIER      (optional) deeper scrape for bio / history       │
├──────────────────────────────────────────────────────────────────┤
│  Backed by web search → wide reach, real noise.                   │
│  Precision lives in step 4. Don't skip it.                        │
└──────────────────────────────────────────────────────────────────┘
```

The honest tradeoff: a web search casts a wider net than a curated profile index,
so it surfaces people the index would miss — but it also surfaces near-misses,
homonyms, and stale records. Step 4 is what turns a noisy pile into a list you
can trust. On a broad search, expect to discard most of what you find.

## Getting Started

Tell me who, or what kind of person, you're after:

- "Find the person who leads developer relations at Vercel."
- "Who is Amara Okafor, the climate-tech founder in Lagos?"
- "Build a shortlist of Heads of Talent at Series A fintechs in Singapore."
- "I need robotics PhDs now working at autonomous-vehicle startups near Munich."
- "Pull together female angel investors backing climate tech in the Nordics."

A single name is a quick lookup. A profile ("X who does Y in Z") triggers the
full pipeline below. If you can hand me extra anchors up front — a company, a
city, an alma mater, a conference they spoke at — I'll find them faster and with
less noise.

## The Pipeline

### 1. Fan out the search

One query is never enough — any single phrasing quietly misses a chunk of the
people you want. Run several varied `web_search` calls and combine them. The
tool batches with `|||`, so a fan-out is one call:

```
web_search(
  query="Head of Talent Series A fintech Singapore
        ||| recruiting lead fintech startup Singapore LinkedIn
        ||| 'talent acquisition' fintech Singapore Series A",
  num_results=20
)
```

Vary along these axes (mix and match — each variant catches a different slice):

- **Role wording** — spell it out and abbreviate: "developer relations" / "DevRel" / "developer advocate"; "Head of Talent" / "recruiting lead" / "TA lead".
- **Company name forms** — "a16z" *and* "Andreessen Horowitz"; "J&J" *and* "Johnson & Johnson". Skip the pairing only when the short form is the brand (IBM, SAP).
- **Anchor the platform** — append the surface where profiles live: `"<name>" LinkedIn`, `"<name>" site:github.com`, `"<role>" "<company>" team`. Snippets from these often carry the title and current company even when the page itself is gated.
- **Slice the scope** — geography, seniority, sub-team, or a distinctive skill. Narrow slices return cleaner hits than one sprawling query.
- **Find the roster, not just the person** — for "everyone who does X at Y," search for the page that lists them: `"<company>" leadership team`, `"<lab>" members`, `"<fund>" partners`. One team or about page can yield a dozen names at once.

Keep each query tight and meaningful — a handful of strong terms beats a long
boolean. If a criterion is semantic ("senior", "early-stage", "AI safety"), keep
it in the query text; the search ranker handles fuzzy intent better than a
keyword pile. Scale the breadth to the ask: 3–4 variants for a focused search,
up to ~8–10 for a wide sweep. Use `num_results` up to 20 on broad sweeps, 5 for a
named lookup. Reach for `search_depth="advanced"` when comprehensiveness matters
more than speed, and `topic="news"` when you're chasing a recent move ("just
joined X", "left Y in 2024").

### 2. Merge and de-duplicate

Pool the hits from every variant and collapse them by URL — the same profile
will show up under several queries. When two hits share a URL, keep the one with
the longer, richer snippet (and note which queries surfaced it; repeated hits are
a useful relevance signal). What you're left with is your candidate set: name,
URL, and whatever the snippet tells you about title / company / location. Carry
the URL with every candidate from here on — it's the source you'll cite, and the
page you'll scrape next.

### 3. Enrich the strong candidates

Search snippets reliably give you a name, a current title/company, and sometimes
a location. They routinely *omit* earlier roles, education, skills, and anything
biographical — and they frequently truncate names to "First L." For the
candidates that look promising, scrape the underlying page to fill the gaps.
`scrape_webpage` batches with commas:

```
scrape_webpage(urls="https://acme.com/team,https://example.org/people/amara-okafor")
```

What to scrape, in rough order of payoff:

- **Company team / about / leadership pages** — clean, current, and list several people at once.
- **Personal sites, conference and speaker bios, GitHub, university/lab pages, Crunchbase, news profiles** — rich and usually scrapeable.
- **The person's primary profile (e.g. LinkedIn)** — try it, but expect login walls and thin content. When the page is gated, fall back to what the *search snippet* and the synthesized `answer` already gave you, and corroborate from a second public source rather than forcing the scrape.

Pull from the scraped markdown the fields your task actually turns on — work
history, tenure, education, location, skills — and attach them to the candidate.
This enrichment is what lets the next step filter on real evidence instead of a
one-line snippet.

### 4. Filter — phrase the criteria as exclusions

This is the precision step, and on any broad search it is **not optional** — web
search returns many people who loosely match and a few who truly do. Go through
the enriched candidates and keep only the real matches.

Filter by exclusion, not inclusion. "Drop anyone who is NOT currently a Head of
Talent, NOT at a Series A fintech, or NOT based in Singapore" yields far fewer
false positives than "keep people who look like Heads of Talent." For each
candidate, decide against the evidence you actually gathered — the snippet plus
the enrichment fields — and when the evidence is genuinely missing, exclude or
flag rather than assume. Briefly note *why* each kept candidate qualifies; it
makes the result auditable and catches your own near-misses.

Don't pre-trim with crude keyword matching to save effort — that silently drops
fuzzy-but-real matches (a translated company name, a city synonym, a truncated
title). Judge each candidate on the merits.

### 5. Dossier (optional)

Only when the deliverable needs depth a list can't carry — full bio,
publications, exact tenure dates, notable projects — do a second, deeper pass on
the *kept* candidates: scrape additional pages about them and assemble the
profile. If a page is empty or gated, run a fresh targeted search
(`"<name>" "<company>" <the-field-you-need>`) instead of guessing. Never
back-fill a dossier field from the thin search snippet — an invented detail will
ship as fact.

## Output Format

For a **named lookup or dossier**:

```markdown
# [Full Name] — [Current Title], [Company]

**Found via:** Web Search
**Profile:** [link]

## Snapshot
[2–3 sentences: who they are, what they're known for, current focus.]

## Background
| Field | Detail |
|-------|--------|
| **Current role** | [Title at Company, since when] |
| **Location** | [City / region] |
| **Previously** | [Notable prior roles] |
| **Education** | [Institutions] |
| **Focus / skills** | [Areas, specialties] |

## Notable
- [Talk, paper, launch, award, or press — with link]

## Sources
- [Source 1](URL)
- [Source 2](URL)
```

For a **candidate list**, link the person's name to their source and keep one
row per match:

```markdown
# [Search description] — [N] matches

| Person | Role & Company | Location | Why they match |
|--------|----------------|----------|----------------|
| [Amara Okafor](https://…) | Founder, GreenGrid (climate tech) | Lagos | Founded a Series-seed climate startup; ex-Tesla energy |
| [Wei Chen](https://…) | Head of Talent, Paywave | Singapore | Leads TA at a Series A fintech, 3 yrs in role |

## Sources
[Every URL is already linked on the matching name above.]
```

## Gotchas

These are the things that have gone wrong before — read them.

- **The name *is* the link.** Always hyperlink the source URL on the person's name. Never deliver a bare name, a separate "LinkedIn" column, or a trailing raw URL: write `[Amara Okafor](https://…) — Founder, GreenGrid`. In tables, link the name cell and drop any standalone URL column. For CSV deliverables (where markdown won't render), keep an explicit `profile_url` column instead.
- **Never invent emails.** A `first.last@company.com` guess is unverified and has reached real deliverables. Either find the address on a scraped page, or omit it and label the row `email_verified: false`. Don't pattern-guess.
- **Names are often truncated** to "First L." in snippets. Resolve the full name from a scraped profile or team page before delivering — don't ship the abbreviation.
- **Don't trust a single source.** Web results go stale: titles change, people move. Corroborate the current role from a second page, and lean on `topic="news"` to catch recent moves. When sources disagree, say so.
- **Coverage has holes.** Very senior executives, public figures, and people without a public profile may be thin or absent on the open web; recent job changes lag. If the obvious search comes up empty, pivot to the company's own pages, news, or the person's own site rather than declaring they don't exist.
- **Gated profiles aren't dead ends.** LinkedIn and similar often block the scrape. The search snippet and synthesized answer usually carry the headline facts — use them, and corroborate elsewhere instead of fighting the login wall.
- **Big result counts ≠ big match counts.** Asking for 20 results gets you 20 keyword hits, not 20 right people. The filter step is what produces the real number.

## Tips for a Better Search

1. **Give me anchors.** A company, city, school, or "spoke at <conference>" cuts noise dramatically.
2. **Name your real criteria.** "Senior, currently there, not a recruiter agency" lets the filter step do its job.
3. **State the goal.** A recruiting shortlist, an outreach list, and a single dossier need different depth — tell me which.
4. **Ask follow-ups.** After a first pass, "now get me their backgrounds" or "narrow to the Berlin ones" refines cheaply.

## Related Skills

- **account-research** — full picture of a company or person before outreach.
- **deep-research** — multi-source, fact-checked report when the question is broader than "who."
