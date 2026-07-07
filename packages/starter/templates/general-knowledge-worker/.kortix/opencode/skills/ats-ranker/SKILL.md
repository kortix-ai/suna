---
name: ats-ranker
description: "Score and rank candidate résumés against one job and hand back an interview shortlist. Use when you already have applicants plus a role and want them triaged by screen-in likelihood — 'rank these CVs for the Staff Backend role', 'who should we interview from this requisition', 'shortlist the applicants in our ATS for this opening'. Pulls applications and résumés from a connected applicant-tracking system, or scores résumé files you upload. Not for finding/sourcing new candidates and not an auto-reject gate."
---

# ATS Ranker

> **Marketplace skill — requires a Kortix ATS connector (e.g. an applicant-tracking system). Install when configured.** It also runs on résumé files you upload directly, so you can try it with no connector at all. Connect your ATS through Kortix connectors to pull applications and résumés automatically — see the `kortix-system` credentials reference for minting a connect link in-chat.

Take a stack of résumés for **one specific job**, judge each against the job description, and return a ranked interview shortlist with a short, evidence-grounded reason per candidate. This is **decision support for a human recruiter** — it ranks screen-in fit, it does not reject anyone.

## What this is — and is not

This skill **ranks candidates you already have** for a role. Reach for it when the request is "who do we interview." It is *not* a sourcing tool: to go find new people, use `people-search`; to draft the outreach once you've picked someone, use `draft-outreach`; for a full company/person picture, use `account-research`. It can feed those, but it stands alone.

## How the scoring works — a transparent LLM rubric

There is **no trained classifier and no proprietary model file here.** Scoring is a transparent, auditable **LLM rubric**: the model reads each `(job description, résumé)` pair, reasons explicitly about the evidence, and emits a score per rubric field with a one-line justification. A plain weighted sum turns those fields into a single screen-in score, and the batch is ranked. You can read every number and the reasoning behind it; you can change the weights; nothing is hidden in a frozen blob.

```
┌──────────────────────────────────────────────────────────────────┐
│                          ATS RANKER                                │
├──────────────────────────────────────────────────────────────────┤
│  1. JD          Pull the job description (ATS posting or pasted)   │
│  2. RÉSUMÉS     Fetch real résumé FILES (ATS) or read uploads      │
│  3. PARSE GATE  Parse to text; show parse status; drop unparsable  │
│  4. RUBRIC      Score each CV vs JD, field by field, with reasons  │
│  5. COMPOSITE   Weighted sum → screen-in score → rank the batch    │
│  6. PRESENT     Ranked shortlist + rationale; unparsable listed    │
└──────────────────────────────────────────────────────────────────┘
```

### The rubric fields

Score every candidate on the **same** fields, each `0–100`, judged strictly from JD-vs-CV evidence — never from a title or a buzzword without backing:

| Field | What it measures | Default weight |
|---|---|---|
| `requirement_match` | How fully the CV evidences the JD's must-haves (skills, scope, years) | **30** |
| `caliber_trajectory` | Seniority/level fit for *this* role + how fast they've risen relative to tenure (penalize over- and under-leveling) | **15** |
| `impact_evidence` | Concreteness and **scale** of quantified outcomes; discount inflated claims with no backing | **15** |
| `ownership_scope` | Scope of what the candidate personally owned and drove (vs. was adjacent to) | **12** |
| `domain_depth` | Depth in the role's specific domain / stack / problem space | **12** |
| `mission_alignment` | Genuine motivation/fit for this role's mission or product area | **8** |
| `selectivity_signal` | Pedigree only — selective employers, schools, awards | **8** |

Plus a **risk** read (not weighted in; subtracted):

| Field | What it measures |
|---|---|
| `reject_risk` `0–100` | Negative flags a recruiter would flag: serial short stints, unexplained gaps, level mismatch, thin/vague evidence |
| `specificity` | `vague` / `mixed` / `concrete` — how concrete the résumé is overall (reported, and a tie-breaker) |

**Composite:**

```
screen_in = Σ(weight_i × field_i) / 100  −  0.20 × reject_risk
```

So the rubric fields contribute up to ~100 and a high reject_risk can pull off up to ~20 points. Weights are **defaults you can override per role** — if the JD is "deep Rust systems, nothing else matters," push `requirement_match` and `domain_depth` up and say so in the output. This is an LLM rubric, not a calibrated statistical model: treat the score as a **relative ranking within this one batch**, not an absolute probability.

### Keeping it consistent (the "calibration")

- **One rubric, every candidate.** Apply identical fields and weights across the whole batch — never re-interpret the rubric mid-list.
- **Spread the scores.** Use the full 0–100 range per field; don't cluster everyone at 50. Clear advances should look clearly different from clear passes.
- **Evidence or it didn't happen.** Every field score must trace to specific résumé text against a specific JD line. If the CV doesn't say it, it doesn't count.
- **Optional self-consistency pass.** For a high-stakes or tightly-bunched batch, score each candidate a second time independently and average the two passes — a light, transparent way to denoise. This is optional; note it if you do it.

## Data integrity — hard rules (do not violate)

1. **Score only candidates whose actual résumé FILE was read and parsed.** From the ATS, download each candidate's real résumé attachment and parse it. A candidate with no parsable résumé is **excluded** and reported separately — never scored.
2. **Never use ATS profile metadata as a stand-in for the résumé.** Parsed-name / parsed-title / parsed-skills fields and profile summaries are *not* the résumé. Do not score from them; they are a fallback note at best.
3. **Show a parse-status table before scoring** — `candidate · status · chars` — where status is `parsed` (≥ ~100 chars, clean) or `FAILED`. Anyone `FAILED` is excluded and listed as unscored. This makes it auditable which résumés were actually read.
4. **Pair each résumé to its candidate by the ATS candidate ID, never by filename.** Download URLs and filenames are the applicant's own upload — often generic (`cv_final.pdf`) or even another person's name. Record `(candidate_id → résumé)` from your own loop; matching by filename can silently score someone on the wrong résumé.
5. **Never hand-fabricate a field.** Every rubric number comes from the model reading the actual JD and CV text with a cited reason. A missing fact is null/excluded, not invented. A weak résumé scores low; it does not get made up.

## Workflow

### 1. Get the job description

- **From a connected ATS:** read the requisition / posting for the role and capture its title, location, and full JD text.
- **From a URL or paste:** if the user gives a posting URL, fetch and read it; if they paste the JD, use that.

Trim scraped pages down to the actual job description before scoring. If you can't get a clean JD, ask for it — every candidate is judged against this text, so it has to be right.

### 2. Get each candidate's résumé file

**Connected-ATS path (preferred).** Through the connected applicant-tracking system:

1. List the job's applications and keep each candidate's **ID and name**.
2. For each candidate, fetch the **résumé file** (the connector returns a download URL or the file itself). As you loop, record the pairing yourself — `{candidate_id, name, source}` — so files are keyed by ID, not filename (hard rule 4). A candidate with no résumé file is left out and reported as unscored (hard rule 1).
3. Download and parse each file to text. Connector download links are usually short-lived (often ~30 min), so download right after listing.

> Applicant-tracking systems differ — one common provider is Ashby, but the flow is the same for any ATS you connect: list applications → fetch résumé files. Use whatever ATS is connected; don't assume a specific vendor. If none is connected, mint a connect link and surface it in-chat (see the `kortix-system` credentials reference), then continue once it's live.

**Upload path (no ATS).** If the user pastes or uploads résumés, read those files directly and parse them to text. Everything downstream is identical.

Produce one record per candidate: `{candidate_id?, name, file, text, chars}`. Then show the **parse-status table** (hard rule 3) and drop the `FAILED` rows.

### 3. Score each candidate against the JD

For every parsed candidate, run the rubric: read the JD and the CV text, reason briefly and concretely (which must-haves are met vs missed, level fit, ownership, standout signal, any reject risk), then assign each field `0–100` with a one-line evidence-grounded justification, plus `reject_risk` and `specificity`. Keep the reasoning attached to the candidate — it becomes the rationale in the output and the audit trail.

Apply the consistency rules above. If you do the optional second pass, average the field scores.

### 4. Compute the composite and rank

For each candidate, compute `screen_in` from the weighted formula, then sort descending. State the weights you used (defaults, or your per-role overrides). Because this is a relative LLM rubric, present it as a ranking within this batch, not a cross-job-comparable number.

### 5. Present the shortlist

Show a ranked table:

```markdown
# Shortlist: [Role] — [N] scored, [M] unscored

**Scored against:** [JD source] · **Weights:** [default | custom — note overrides]

| Rank | Candidate | Screen-in | Why (evidence) | Watch-out |
|------|-----------|-----------|----------------|-----------|
| 1 | [Name] | 84 | Meets all 5 must-haves; owned the billing rewrite (cut latency 60%); ex-Stripe | — |
| 2 | [Name] | 79 | Strong domain depth, slightly under-leveled for the scope | One 9-mo stint |
| … | | | | |

## Recommended to interview
[Top scorers — the shortlist you'd actually screen]

## Unscored (no parsable résumé)
- [Name] — no résumé file in ATS
- [Name] — file failed to parse (12 chars); ask for a clean copy
```

Lead with the recommended shortlist. Always call out the unscored candidates separately. Remind the user the score ranks **screen-in fit** and is decision support for a human — **not an automatic reject gate**, and not a prediction of who gets hired.

If the user didn't ask for a shareable page, stop here — and offer it as a single follow-up line: *"I can turn this into a private, read-only leaderboard page (and refresh it automatically as new applicants come in)."*

### 6. Optional — a shareable leaderboard page

Only when the user asks for a shareable page / dashboard, or accepts the offer above. Build it with the `talent-pool-rendering` skill (which uses our `website-building` / `webapp` tooling) — feed it your scored candidates, their rubric breakdowns, and rationales. Keep it **read-only** for a pure ATS ranking: no candidate writes back to the ATS, no outreach, no notifications — hand the user the URL and stop.

**Automatic refresh (optional).** If the user wants the page to stay current, set up a Kortix **cron trigger** for a daily incremental run: diff the ATS application list against the candidates you've already scored, score only the new ones with the same rubric and weights, append them, and re-render the same page (the URL stays stable). Don't re-score people already in the list — the rubric and weights are fixed for the requisition so existing ranks don't drift. No new applicants → nothing to redeploy.

## Notes

- **Relative within one job.** The ranking is the product; don't compare raw scores across different requisitions.
- **No demographic features, ever.** Score on JD-relevant evidence only. Do not add or infer age, gender, ethnicity, or any protected attribute.
- **Garbage in → flag, don't score.** A résumé that parsed to a handful of characters is unscored, not guessed.
- **Show your work.** Every score ships with its reason. That's the whole point of an LLM rubric over a black box.
