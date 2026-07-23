# Sourcing — recurring outbound candidate sourcing

> **Marketplace skill — requires a Kortix ATS connector (e.g. an applicant-tracking system). Install when configured.** The ATS connection is what makes this a *closed loop*: it lets the workflow exclude people already in your pipeline and ingest who got hired. Mint a connect link in-chat per the `kortix-system` credentials reference. With no ATS connected the sourcing + review loop still runs; it just can't dedupe against your live pipeline.

This part of `generic-recruiting` owns a **standing, repeatable sourcing pipeline** for a role — not a single search. Each run sources fresh candidates, removes anyone already in your ATS or already reviewed, ranks the rest, refreshes a review surface a recruiter actually clicks through, and folds their decisions back in so the next run is sharper. It's the recurring machine; the one-shot search underneath it is `people-search`.

## When to load this — and when not to

Reach for this when the request is to **run, schedule, debug, rebuild, or modify the recurring workflow**. Triggers: "do the next sourcing run," "set up weekly sourcing for the Staff SRE role," "the review app isn't saving decisions," "regenerate the candidate review page."

Do **not** use it for a one-off lookup ("find me 5 senior PMs in Berlin") — that's `people-search`. Don't use it to write a Slack/email announcement *about* the workflow, to summarize recruiter feedback, or to discuss recruiting strategy. The request has to be about *operating the pipeline itself*.

## The loop

```
        role brief  +  prior reviewer decisions  +  cadence
                              │
                              ▼
     ┌──────────────  people-search  ──────────────┐
     │   source → enrich → filter (delegated)       │
     └──────────────────────────────────────────────┘
                              │
                              ▼
        dedupe against ATS pipeline + past reviews + hired patterns
                              │
                              ▼
        rank by readiness (readiness-ranking.md) or fit signals
                              │
                              ▼
        persist candidate state (keyed by profile URL)
                              │
                              ▼
        review surface  ──  recruiter marks Yes / Maybe / No + notes
        (backend-backed page built with webapp tooling)
                              │
                              ▼
        decisions persist  →  ingested by the NEXT run
```

## Building blocks — reuse, don't reinvent

Sourcing is the **orchestrator** among the recruiting pipeline parts. It composes other skills/references rather than re-implementing them:

- **`people-search`** owns every search / enrich / filter primitive. Run a sourcing pass by following its pipeline; do not write your own search recipes here. If sourcing needs new search behavior, improve `people-search` and consume it.
- **`references/readiness-ranking.md`** (or `references/ats-ranking.md` if you're scoring against a JD) does the ranking. Don't hand-roll a scorer.
- **`references/talent-pool.md`** / **`webapp`** build the review surface. Don't hand-author one-off HTML.
- The **ATS connector** supplies the dedupe truth: who's already applied, who's in process, who got hired.

Your job is the *glue and the state* — the parts that make repeated runs coherent.

## Data integrity — hard rules (do not violate)

1. **Candidate state is keyed by profile URL and persists across runs.** Never lose a recruiter's Yes/Maybe/No or notes when you re-run sourcing. A re-run refreshes candidate metadata; it does not wipe review decisions.
2. **Dedupe before you present.** Exclude anyone already in the ATS pipeline, anyone reviewed `No` in a prior run, and anyone matching a "hired"/"already-employed-here" pattern. Re-surfacing someone the recruiter already rejected erodes trust in the whole loop.
3. **Reviewer writes must be durable and fail loud.** Every Yes/Maybe/No and note is saved to a real backend, not browser memory. A failed save shows the reviewer an explicit error ("Save failed — retry"), never a silent success. A page that can't persist is a preview, not a review surface — don't hand it out as one.
4. **No demographic features in sourcing or ranking.** Source and rank on role-relevant evidence only.
5. **No real candidate PII in sample/fixture data.** Any seed or demo data must be synthetic. Real candidate data lives only in the live store.

## Workflow

### 1. Intake

Read the **role brief** (title, must-haves, location, level), the **hiring company**, the **run cadence** (weekly? on demand?), and **all prior reviewer decisions and free-text feedback** for this role. The feedback is the steering wheel — "too junior," "we want infra not app," "stop showing agency recruiters" — bake it into the search and filter criteria for this run.

### 2. Source

Run the sourcing pass via `people-search`: fan out varied queries for the role/skills/geography, merge and dedupe, enrich the strong candidates, and filter by exclusion down to real matches. Carry every candidate's profile URL through — it's the key for everything downstream.

### 3. Dedupe against the live pipeline

Through the connected ATS, pull the current applicants/pipeline for the role plus any hired/known-employee patterns, and **remove those people from the new batch** (hard rule 2). Also drop anyone previously reviewed `No`. What remains is genuinely *new* candidates worth a recruiter's attention.

> ATS vendors vary — Ashby is one example, but read whichever ATS is connected. Access it generically: list the role's applications / pipeline, read hired markers, treat them as an exclusion set. If no ATS is connected, say so and proceed without pipeline dedupe (still dedupe against your own prior runs).

### 4. Rank

Rank the new candidates so the recruiter reviews the best first. For outreach prioritization use readiness-to-move ranking (`references/readiness-ranking.md`); if you're screening against a written JD, use ATS ranking (`references/ats-ranking.md`). Either way the ranking is a transparent rubric, not a black box — carry each candidate's score and reason.

### 5. Persist

Write the run's candidates into the workflow's persistent store, keyed by profile URL, **merging** with prior state so existing review decisions survive (hard rule 1). New candidates come in `unreviewed`; previously-seen ones keep their decision and just refresh their metadata.

### 6. Refresh the review surface

Regenerate the **review page** — a backend-backed app (built with the `webapp` template / talent-pool rendering, see `references/talent-pool.md`) that lists each candidate with their rank, signals, and profile link, and lets a recruiter mark **Yes / Maybe / No** and leave notes. The frontend reads the candidate list from the backend on load and writes every click straight back to it (hard rule 3). Keep the conventions tight: Yes/Maybe/No (no extra states), a single notes field, score shown on a clean scale, profile link on every card.

Stand up the backend, seed it from the persisted store, deploy it, and **verify end-to-end through the deployed URL before sharing it** — confirm reads return the seeded candidates and that a test Yes/Maybe/No and note round-trip (write, then re-read). A static page with a dead backend means every reviewer click fails — never hand that out.

### 7. Close the loop

When the recruiter reviews, their decisions land in the store. The **next run reads them**: `No` → excluded from future sourcing, `Yes`/`Maybe` → kept, and the free-text feedback re-tunes the search criteria. That's the whole point — each run should feel like it learned from the last.

### 8. Schedule it

For a recurring pipeline, set up a Kortix **cron trigger** at the agreed cadence (weekly is typical; don't go tighter unless asked). Each scheduled run repeats steps 2–6 incrementally and reseeds the same review page, so the URL is stable and the recruiter's prior decisions persist. Triggers are declared in the project manifest, so the automation is versioned like the rest of the project.

## Notes

- **One source of truth.** The persistent candidate store is canonical; the review page is a view of it. Don't let the UI hold state the store doesn't.
- **Delegate the primitives.** If you find yourself writing a search loop or a scorer here, stop and use `people-search` / readiness-ranking instead.
- **The feedback is the product.** A sourcing run that ignores last week's "too junior" is a worse run. Always ingest decisions before sourcing.
- **Decision support, not autopilot.** The workflow surfaces and ranks; a human decides. No auto-outreach from this workflow — that's `draft-outreach`.
