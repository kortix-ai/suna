# Talent Pool Rendering — a shareable, tiered leaderboard

> **Marketplace skill — requires a Kortix ATS connector (e.g. an applicant-tracking system). Install when configured.** Strictly, this rendering step works from scores you already have, so it can run with no connector. It's grouped with the recruitment connector skills because its input usually comes from ATS ranking / readiness ranking / sourcing (`references/ats-ranking.md`, `references/readiness-ranking.md`, `references/sourcing.md`), which do use an ATS. Connect one in-chat via the `kortix-system` credentials reference when you want the upstream scoring too.

Take a set of **already-scored candidates** and render a **Talent Pool**: a ranked leaderboard bucketed into tiers, where each candidate opens a breakdown of the signals behind their score, with methodology and workflow context below the grid. This is the *presentation layer* for the recruitment rankers — it does no scoring of its own.

## Two modes

```
   scored candidates (from ats-ranking / readiness-ranking / a manual list)
                              │
                              ▼
             build with website-building / webapp tooling
                              │
                ┌─────────────┴──────────────┐
                ▼                              ▼
        READ-ONLY page                 BACKED page (+ backend)
        (preview / share a            (reviewers ADD candidates;
         fixed ranking)                they persist across reloads)
```

- **Read-only (default).** A leaderboard that shows a ranking and its reasoning. Use it to share a shortlist or screenshot a result. Nothing writes back.
- **Backed.** The same page plus a small backend (the `webapp` template) so a reviewer can **add a candidate** and have it survive a reload. Use this only when adding candidates is actually needed — a read-only deploy will show "Save failed — retry" on every add and store nothing.

**Build it with our own web tooling.** Render the page using the `website-building` and `webapp` skills and the Kortix design system — not a one-off hand-authored HTML file and not any external renderer. Load `website-building` (and `webapp` for the backed mode) and follow their workflow.

## The data contract

The page renders from a structured bundle — **render only from structured data; never let the model write HTML strings directly.** If you need a new field on the page, add it to the bundle shape first, then render it.

A Talent Pool bundle is roughly:

```jsonc
{
  "role": "Senior Platform Engineer",
  "generated": "2026-06-29",
  "method": {
    "summary": "LLM-rubric screen-in ranking — transparent weighted fields, not a trained model.",
    "signals": [ { "key": "requirement_match", "label": "Requirement match", "weight": 30 }, … ]
  },
  "tier_thresholds": { "A": 75, "B": 55, "C": 0 },
  "candidates": [
    {
      "id": "c_001",
      "name": "Jordan Avery",
      "headline": "Staff Engineer, Payments",
      "current_position": "Staff Engineer @ Northwind",
      "profile_url": "https://…",
      "final_score": 84,
      "tier": "A",
      "signals": [ { "key": "requirement_match", "value": 90, "note": "Meets all 5 must-haves; owned billing rewrite" }, … ],
      "rationale": "Strong domain depth, ex-Stripe, clear ownership.",
      "source": "ranker"          // or "manual" for reviewer-added rows
    }
  ]
}
```

This is exactly the shape ATS ranking and readiness ranking already produce (rank + score + per-field signals + rationale). Pass theirs straight in.

## Rendering rules

- **Leaderboard first.** The ranked, tiered grid is the primary surface and spans the page. Methodology, companies-in-scope, and workflow/status sit **below** it — never push the grid aside. A top nav can offer jump links (Candidates · Methodology · Workflow).
- **Tier assignment is simple and deterministic.** If a candidate carries a `tier`, keep it. Otherwise bucket `final_score` with `tier_thresholds` (e.g. ≥75 → A, ≥55 → B, else C). No model judgment in tiering — it's arithmetic.
- **Show the method, because the score is a transparent rubric.** Render a Methodology section that lists the rubric signals and their weights and states plainly: *this is an LLM-rubric ranking — decision support, relative within this pool, not a trained classifier and not an auto-reject gate.* That honesty is a feature; surface it.
- **Per-candidate breakdown.** Each row opens a drawer/detail showing every signal's value and its one-line note, the rationale, and the profile link. The reasoning travels with the score.
- **Safe links only.** Render profile URLs as text-only `<a target="_blank" rel="noopener noreferrer">` and validate the scheme — only `http`/`https`. Drop anything else at render time. Only the link text is clickable; no surrounding icon hit-area.
- **Dedupe headline vs current position.** If `headline` is just a token-subset of `current_position`, render only the current position.
- **No real candidate PII in samples.** If you need demo data to preview the layout, generate synthetic candidates in a scratch location — never commit real candidate data or fixtures into the project.
- **Reviewer adds fail loud (backed mode).** An add returns the persisted row on success; any failure shows "Save failed — retry" in the form. Never keep an added candidate only in browser memory.

## Workflow

### Read-only page

1. Get the scored bundle (from ATS ranking / readiness ranking, or assemble one from a manual list).
2. Load `website-building`; build the leaderboard page from the bundle following its design workflow and the rendering rules above. Apply tiers, the per-candidate breakdown, the methodology section, and safe links.
3. QA it (desktop + mobile screenshots, the website-building visual checks), then deploy/preview using that skill's normal flow. Hand the user the URL.

### Backed page (reviewers add candidates)

1. Do everything above, then load `webapp` and add a small backend that serves the bundle (read) and accepts new candidates (write), persisting them.
2. The frontend fetches the candidate list from the backend on load and POSTs each reviewer-added candidate back to it. Reviewer-added rows are tagged `source: "manual"` and survive a reseed.
3. Deploy via the `webapp` flow, then **verify through the deployed URL before sharing**: confirm the list loads from the backend and that adding a candidate persists across a reload. A static deploy is a preview, not a review surface.

## Scope

This part of `generic-recruiting` **renders and deploys** a ranking. It does not:

- score or re-rank candidates — that's ATS ranking / readiness ranking (`references/ats-ranking.md`, `references/readiness-ranking.md`);
- collect Yes/Maybe/No review decisions — that's sourcing's review surface (`references/sourcing.md`; this rendering step's only write path is *add a candidate*);
- edit or delete persisted candidates (add-only for now);
- schedule tier refreshes or send tier-change alerts (out of scope).

## Notes

- **It's a view, not a source of truth.** The ranking lives upstream; this page reflects it. Re-render when the scores change.
- **Keep it honest.** The methodology section should make clear what the score is and isn't. Don't dress a transparent rubric up as a precise predictor.
- **One design system.** Use Kortix design tokens via `website-building`; don't invent bespoke chrome per pool.
