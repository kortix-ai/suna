---
name: entity-search
description: "High-precision people and company lookup backed by a Kortix people-data connector (enrichment, prospecting, or contact-data provider such as Apollo, People Data Labs, Clearbit, Clay, RocketReach). Use when such a connector is configured and you need verified profiles, work emails, phone numbers, employment history, or org charts — or to enrich an existing list of names, domains, or profile URLs into full records. When no people-data connector is present, hand off to the web-search people-search skill instead."
---

# Entity Search

> **Marketplace skill — richer entity/people lookup via a Kortix people-data connector; for the default web-search version use the people-search skill.**

This is the connector-backed sibling of `people-search`. When the project has a
people-data connector wired up — an enrichment, prospecting, or contact-data
provider — it returns **structured, verified records** (real work emails, phone
numbers, employment history, education, org charts) instead of the open web's
scraped, noisier snippets. Reach for it when precision and verified contact
fields matter; otherwise the web path in `people-search` is the right tool.

This skill is deliberately thin: it owns the *connector* decision and the
provider-call mapping. The find → merge → enrich → **filter** reasoning lives in
`people-search`, and this skill reuses it rather than restating it.

## Step 0 — Is a people-data connector available?

This is the only branch that matters. List the project's usable connectors and
look for one whose job is people/company data:

```sh
kortix executor connectors          # or the `connectors` MCP tool (always loaded)
```

A connector qualifies if it's an **enrichment / prospecting / contact-data**
provider — e.g. Apollo, People Data Labs, Clearbit, Clay, RocketReach, Hunter,
Lusha, ZoomInfo. (CRMs like Salesforce/HubSpot can enrich known contacts too,
but they don't *discover* people — treat them as a supplement.)

- **A qualifying connector is connected →** run the connector path below.
- **None connected →** defer to `people-search` (the web pipeline). Optionally
  offer to wire one up (see *Wiring up a connector*) — but don't block the
  user's request on it; the web path already answers most asks.

## The connector path

Two operations cover almost everything. They map cleanly onto the provider's
actions; the exact action names vary per connector, so inspect the connector's
tool schema (the executor exposes each connected app's actions as callable
tools) and pick the closest match.

### 1. Find / shortlist  *(search by criteria)*

The connector's **people-search / prospect-search** action takes structured
filters — name, job title, company, location, seniority, headcount, industry,
education, skills — and returns candidate profiles from a curated index. Because
the index is curated, recall is cleaner than a web sweep, but it is **not**
exhaustive: niche roles, very senior people, and anyone outside the provider's
coverage region can be missing.

Still fan out, the same way `people-search` does — one filter combination quietly
misses people. Vary title wording ("VP Engineering" / "Head of Engineering"),
company name forms, and scope slices across a few calls, then merge by a stable
key (profile URL or provider person-id).

> Example: *"Find VPs of Engineering at Series B healthtech companies in
> Boston."* → a couple of search calls varying title and the healthtech/biotech
> framing, merged.

### 2. Enrich  *(resolve a known person/company into a full record)*

The connector's **enrich / profile-lookup** action takes an identifier you
already have — a name+company, an email, a domain, or a profile URL — and returns
the fielded record: verified email, phone, current and previous companies,
education, skills, seniority, social handles. This is the high-value path: feed
it a list and get back clean rows with no scraping.

> Example: *"Enrich these 40 webinar registrants into verified work emails and
> current titles."* → batch the list through the enrich action, one row out per
> row in.

Batch where the action supports it, and respect the provider's per-call ceiling
and credit budget — loop in chunks rather than firing one call per person.

### 3. Filter — same discipline as people-search

A curated index still returns people who only *loosely* match. **Do not skip the
filter step.** Phrase criteria as exclusions ("drop anyone NOT currently a VP+,
NOT in healthtech, NOT Boston-area") and judge each candidate against the fielded
data the enrich step returned. The full rationale and pitfalls are in
`people-search` → *Filter — phrase the criteria as exclusions*; follow it there.

## Wiring up a connector (when none exists)

Don't send the user to a dashboard. Use the credentials flow
(`kortix-system` → *Credentials & setup links*):

- **Pipedream-backed app** (most prospecting tools) — add it instantly, then mint
  a 1-click connect link:
  ```sh
  kortix executor add apollo --provider pipedream --app apollo   # add_connector tool
  kortix executor connect apollo                                 # connect tool → link
  ```
- **API-key provider** (e.g. a People Data Labs key) — mint a secret link instead:
  ```sh
  kortix secrets request PDL_API_KEY --scope connector          # request_secret tool
  ```

Surface the URL, end your turn, and verify it landed (`kortix executor connectors`
/ `kortix secrets ls`) when the user returns.

## Output

Use the same shapes `people-search` defines (named dossier, or a one-row-per-match
table) — with two changes:

- **Source line** names the connector, not "Web Search": `**Found via:** Apollo`.
- **Verified-contact fields** carry through. An email from the connector is
  verified — label it `email_verified: true`. Anything you didn't get from the
  connector stays absent or `email_verified: false`. The name is still the link.

## Gotchas

- **Verified ≠ guessed — and still never fabricate.** Emit only contact fields
  the connector actually returned. A `first.last@company.com` guess is as wrong
  here as on the web path.
- **Coverage and credits are real limits.** Providers charge per lookup and have
  regional/segment blind spots. A connector miss is **not** proof the person
  doesn't exist — fall back to `people-search` on the open web for the gaps.
- **The connector is a supplement to judgment, not a replacement for it.** It
  sharpens recall and verification; the exclusion-based filter is what produces
  the right *count*.
- **Respect compliance gating.** Some providers restrict contact data by region
  or use case. If an action returns a permission/region error, surface it plainly
  rather than working around it.

## Related skills

- **people-search** — the default, web-search-backed version. The fan-out → merge
  → enrich → filter pipeline lives there; this skill reuses it.
- **account-research** — full company/person picture before outreach; pairs well
  with an enrichment connector.
