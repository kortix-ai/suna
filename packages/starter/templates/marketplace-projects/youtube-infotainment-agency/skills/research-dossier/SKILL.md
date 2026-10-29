---
name: research-dossier
description: Research an approved episode brief into a sourced dossier and a claims.json of atomic, quoted, tiered claims. Load for stage 2 research, or whenever new facts must be added to an episode.
---

# Research dossier (stage 2)

The research is the product. Copycat channels can clone a look; they cannot clone traceable truth.
Kurzgesagt spends ~100 hours per video here. You have tools — use them thoroughly.

## Method
1. Read `01-brief.json`. Turn each key question into search queries. Look for, in order:
   1. **Primary**: peer-reviewed papers, review articles, agency/institution pages (NASA, NOAA, NIH,
      CERN, IPCC, national statistics), datasets, university textbooks/lecture notes.
   2. **Secondary**: reputable science journalism (Quanta, Nature News, Science News), encyclopaedias.
   3. **Tertiary**: explainers, Wikipedia — **only to find primary sources**, never as sole support.
2. Open and read every source you cite (web_search / scrape_webpage tools, or `agent-browser` for
   pages that need a browser). If you can't open it, you can't cite it.
3. Extract **atomic claims**: one checkable statement each ("Blue light is scattered ~5.9× more than
   red" not "Light scatters, which is why the sky is blue and sunsets are red").
4. For each claim copy a **verbatim quote** with a locator (section, page, figure, table). Numbers
   keep their units and the source's precision.
5. Map nuance: uncertainty ranges, competing explanations, the common wrong explanations (these
   become great script beats), and what a pedant would object to.
6. Collect visual leads: diagrams in papers, datasets worth animating, analogies experts use.

## Outputs
- `02-research/dossier.md` — narrative synthesis organised by the brief's key questions; every
  paragraph cites claim ids `[c07]`; sections for Nuance & caveats, Common misconceptions,
  Numbers & comparisons (pre-computed, with working), Visual leads, Open questions.
- `02-research/claims.json` — schema `Claims` (`pipeline/src/schemas.ts`):
```json
{
  "sources": [{ "id": "s01", "url": "…", "title": "…", "publisher": "…", "authors": ["…"],
               "published": "2019", "tier": "primary", "type": "paper", "accessed_at": "<ISO>" }],
  "claims": [{ "id": "c01", "text": "…", "source_ids": ["s01"],
               "quotes": [{ "source_id": "s01", "quote": "verbatim…", "locator": "§3, Fig. 2" }],
               "confidence": "high", "status": "unverified" }]
}
```
Leave `status: "unverified"` — only the fact-checker changes it.

## Bar
Aim for 15–40 claims for a 6–8 min video; ≥60 % backed by a primary source
(`bin/yt claims stats <slug>` reports `primary_share`). Check: `bin/yt validate <slug> research`.

## Never
Invent or "reconstruct" quotes. Cite a source you didn't open. Round numbers in claims (round in the
script). Use AI-generated summaries as sources.
