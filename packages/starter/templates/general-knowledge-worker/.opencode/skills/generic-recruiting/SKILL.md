---
name: generic-recruiting
description: "Generic starter template — run recruiting workflows end to end: source candidates for a role, rank them (by JD fit or by readiness-to-move), shortlist, and render a shareable talent pool leaderboard. Use to run/schedule/debug a recurring outbound sourcing pipeline ('do this week's sourcing run for the Platform role', 'set up recurring sourcing', 'regenerate the candidate review app'); to score and rank résumés/CVs against an opening ('rank these CVs for the Staff Backend role', 'who should we interview from this requisition', 'shortlist the applicants in our ATS'); to rank candidates by readiness to move ('who on this list is most likely to move', 'prioritize these profiles for outreach', 'who's overdue for a change'); or to build/deploy a shareable ranked talent pool page ('build a leaderboard from these scores', 'make a shareable talent pool page', 'deploy the candidate dashboard'). Not for one-off people lookups (people-search) or drafting outreach messages (draft-outreach)."
defaultProjectInstall: true
---

> **TODO — make this yours.** This is a generic starting template. Edit it to fit your own recruiting operation: your ATS and how candidates are pulled, your scoring rubric and must-haves, your sourcing channels and outreach cadence, and your talent-pool format. Delete what you don't use.

# Recruiting

> **Marketplace skill — requires a Kortix ATS connector (e.g. an applicant-tracking system). Install when configured.** Every part below also works with reduced functionality with no connector: sourcing runs without pipeline dedupe, ranking runs on uploaded résumés or provided profile URLs, and rendering works from any scored bundle. Mint a connect link in-chat per the `kortix-system` credentials reference to unlock the closed-loop behavior.

This skill covers the whole recruiting pipeline for a role, from finding people to a shareable ranked view of them. It's a **router**: skim this file to see which part of the pipeline the request is about, then open the matching reference doc for the concrete methodology, rubric, hard rules, and workflow steps. Don't try to hold all four parts in your head at once — load only the reference(s) the task needs.

## The pipeline

```
   role brief + cadence
          │
          ▼
   ┌─────────────────┐    people-search does the actual finding;
   │   1. SOURCE     │ ── this is the recurring outbound loop around it
   └─────────────────┘
          │
          ▼
   ┌─────────────────┐    fit-vs-JD (ats-ranking)  or
   │   2. RANK       │ ── readiness-to-move (readiness-ranking) — or both
   └─────────────────┘
          │
          ▼
   ┌─────────────────┐    a human recruiter/sourcer decides from the
   │   3. SHORTLIST  │ ── ranked, evidence-backed list — never autopilot
   └─────────────────┘
          │
          ▼
   ┌─────────────────┐    render the ranked list as a shareable,
   │   4. RENDER     │ ── tiered leaderboard (talent pool)
   └─────────────────┘
```

These four parts compose: sourcing calls into ranking to prioritize what it finds and into rendering to build its review surface; ranking can hand its output straight to rendering for a shareable page. They can also be used standalone — e.g. rank a batch of résumés someone already collected, with no sourcing or page involved.

## When to reach for each part

| Ask sounds like... | Load |
|---|---|
| "Do this week's sourcing run", "set up recurring sourcing for the Staff SRE role", "the review app isn't saving decisions", "regenerate the candidate review page" | `references/sourcing.md` |
| "Rank these CVs for the Staff Backend role", "who should we interview from this requisition", "shortlist the applicants in our ATS for this opening" | `references/ats-ranking.md` |
| "Who on this list is most likely to move", "prioritize these profiles for outreach", "who's overdue for a change" | `references/readiness-ranking.md` |
| "Build a leaderboard from these scores", "make a shareable talent pool page", "deploy the candidate dashboard" | `references/talent-pool.md` |

Not this skill at all:
- One-off people lookup ("find me 5 senior PMs in Berlin") → `people-search`.
- Drafting the outreach message itself → `draft-outreach`.
- Full company/person background for an outreach or diligence context → `account-research`.

## Cross-cutting rules (apply across every part)

These hold everywhere in the pipeline, not just in one reference doc — check the specific reference for the full list, but keep these front of mind:

1. **Decision support, not autopilot.** Every part of this pipeline ranks, scores, or surfaces — a human always makes the actual yes/no call. No auto-reject, no auto-outreach.
2. **No demographic features, ever.** Source, rank, and render on role-relevant evidence only — never protected attributes.
3. **Evidence or it didn't happen.** Every score/field traces to real text (a résumé line, a profile fact, an ATS record) with a cited reason. Never fabricate a field or invent a fact.
4. **Real data lives in real stores.** No real candidate PII in sample/fixture/demo data — synthetic only. Live data belongs in the live store (ATS, persistent workflow state), never hardcoded or left only in browser memory.
5. **Writes are durable and fail loud.** Anywhere a human writes back (reviewer Yes/Maybe/No, a manually-added candidate), the write goes to a real backend and a failure shows an explicit error — never a silent no-op.
6. **Keyed by profile URL / candidate ID.** Never by filename or free-text name matching — that's how candidates get scored on the wrong résumé or lose their review history.
7. **Rankings are relative, not absolute.** Every score here (`screen_in`, `readiness`) is an LLM rubric read within one batch/run — say so in outputs; never present it as a calibrated probability or an auto-decision.

## Reference docs

- `references/sourcing.md` — the recurring outbound sourcing pipeline: intake → source (via `people-search`) → dedupe against the ATS → rank → persist → refresh the recruiter review surface → close the loop → schedule.
- `references/ats-ranking.md` — score and rank résumés against one job description; the rubric fields and weights, the parse-and-pair hard rules, and the shortlist output format.
- `references/readiness-ranking.md` — rank an existing (or freshly sourced) candidate list by readiness to move; the pulls/anchors rubric, the deterministic career-fact inputs, and the outreach-priority output format.
- `references/talent-pool.md` — render already-scored candidates as a shareable, tiered leaderboard page (read-only or backed for reviewer adds); the data contract and rendering rules.

## Building blocks this skill composes (not owned here)

- **`people-search`** — the actual search/enrich/filter primitives sourcing runs on top of.
- **`draft-outreach`** — writes the outreach message once a candidate is picked; out of scope for this skill.
- **`website-building` / `webapp`** — the rendering and backend tooling the talent pool and review surfaces are built with.
- **`account-research`** — full company/person background, if a request needs more than a ranking.
