# Readiness Ranking — rank candidates by readiness-to-move (RTM)

> **Marketplace skill — requires a Kortix ATS connector (e.g. an applicant-tracking system). Install when configured.** It also works on a plain list of profile URLs you provide or source, so you can run it with no connector. Connecting an ATS or CRM lets you pull a working candidate list and write priorities back — mint a connect link in-chat per the `kortix-system` credentials reference.

Order a list of candidates by **readiness to move** — how likely each person is to respond to outreach and actually change employer in the next ~6 months — so a sourcer spends their outreach budget on the people most likely to answer. Output is a ranked outreach list with a readiness score and a short reason per person. Decision support for a human sourcer.

## Readiness is not quality

This score says **nothing** about whether someone is good, hireable, or would pass an interview. A mediocre candidate can be wide open to a move; a star can be perfectly happy and locked in. If you want CV-vs-JD interview fit, that's ATS ranking (`references/ats-ranking.md`). If you want to *find* people, that's `people-search`. This part of `generic-recruiting` only answers: *of the people we already have, who's most reachable right now?*

## How the scoring works — a transparent LLM rubric

No trained model, no frozen weights file. Scoring is a **transparent LLM rubric**: the model reads each fetched profile (plus a few career facts computed deterministically from the dates), reasons about what's pulling the person toward a move versus what's anchoring them in place, and scores a set of named fields with explicit justifications. A readable weighted formula combines them into one readiness score, and the list is ranked. Every number and reason is inspectable; the weights are yours to tune.

```
┌──────────────────────────────────────────────────────────────────┐
│                        RTM RANKER                                  │
├──────────────────────────────────────────────────────────────────┤
│  1. TARGET     Role being hired + hiring company                   │
│  2. PROFILES   Existing URLs, or source fresh via people-search    │
│  3. FETCH      Pull profile text + structured fields per URL       │
│  4. FACTS      Compute tenure / cadence from dates (code, not LLM) │
│  5. RUBRIC     Score PULLS toward move − ANCHORS in place          │
│  6. RANK       Weighted readiness score; open-to-work as a column  │
└──────────────────────────────────────────────────────────────────┘
```

### The rubric fields

Two forces. **Pulls** raise readiness; **anchors** lower it. Each `0–100`, judged only from the profile text and the computed facts:

**Pulls toward a move** (added):

| Field | What it measures | Default weight |
|---|---|---|
| `move_likelihood` | Overall readiness read: restlessness, signals of looking, cadence vs current tenure | **30** |
| `tenure_overdue` | Current tenure measured against *their own* historical job-change cadence (long overdue = high) | **18** |
| `next_step_alignment` | Is the target role the natural next rung of their trajectory? | **12** |
| `role_plateau` | Stagnation — no recent growth, title, or scope change at the current employer | **12** |
| `growth_ceiling` | Limited remaining runway / headroom where they are | **8** |

**Anchors in place** (subtracted):

| Field | What it measures | Default weight |
|---|---|---|
| `recent_promotion` | Recently rewarded — promotion or visible scope expansion | **−12** |
| `career_momentum` | Visible in-place momentum, thriving, freshly moved | **−8** |

**Composite:**

```
readiness = Σ(pull_weight × pull_field)/100  −  Σ(anchor_weight × anchor_field)/100
```

A profile that's long overdue, plateaued, and where the target role is an obvious step up scores high; someone freshly promoted and visibly thriving scores low even if they look great on paper. Weights are **defaults — override them per search** (e.g. for a market where everyone job-hops, lean harder on `tenure_overdue`). This is an LLM rubric, so read the score as a **relative ranking within this run**, never an absolute probability.

### Deterministic career facts (compute, don't judge)

Some inputs shouldn't be guessed by the model — compute them in code from the parsed experience dates, anchored to today:

- **average tenure** across past roles, and **current-role tenure**
- **jobs per year** (change cadence)
- whether current tenure already exceeds their average

Feed these to the rubric so `tenure_overdue` and `move_likelihood` are grounded in arithmetic, not vibes. Never hand-edit them.

### Keeping it consistent (the "calibration")

- **One rubric for the whole list**, identical weights across everyone.
- **Spread the scores** across the full range — clearly-overdue stagnating profiles land high, recently-moved or thriving profiles low; don't bunch at the middle.
- **Evidence only.** Each field traces to specific profile text or a computed fact. Missing evidence → exclude or flag, never assume.
- **Optional second pass** for tight clusters: score independently twice and average — a light, transparent denoise. Note it if used.

## Data integrity — hard rules (do not violate)

1. **Score only profiles that were actually fetched.** A candidate is scoreable only when the fetch returned real profile text (> ~100 chars) or a structured record. Robots-blocked / unfetchable profiles are **excluded** and reported separately — never scored from a one-line search snippet.
2. **Key everything by profile URL** — search hits, fetches, scores. So no one is ever scored on someone else's profile.
3. **Open-to-work badges are reporting, not a feature.** If a profile shows an "open to work" signal, surface it as its own column in the output. Do **not** edit it into the profile text or let it move a rubric field — the rubric should stand on its own evidence.
4. **The score ranks readiness, not quality** — say so plainly in the output, and never present the ranking as a hiring shortlist.
5. **Never fabricate a field.** Every rubric number comes from the model reading the actual profile plus the computed facts. A missing fact is null/excluded, not invented.

## Workflow

### 1. Pin down the target

Parse the request into the **role being hired** (e.g. "Senior Data Engineer") and the **hiring company** (a name, or a short descriptor like "a Series-B climate startup"). Both shape `next_step_alignment` — if either is missing, ask before scoring.

### 2. Get the candidate list

- **Existing list:** the user already has profile URLs → use them directly, keyed by URL.
- **Source fresh:** run `people-search` for the role / location / skills and take the deduped, filtered profile URLs from its output. Keep the pool modest (≤ ~100 per run) so the per-profile fetch + rubric stays fast.
- **From a connected ATS/CRM:** pull a candidate list or talent pool and use the profile URLs on those records.

### 3. Fetch each profile

For every URL, pull the page text and any structured fields (current title, company, location, experience history). Report the unfetchable ones separately (hard rule 1). Carry the URL with every candidate — it's the key and the source you'll cite.

### 4. Compute the career facts

From each profile's parsed experience dates, compute the deterministic facts above (average tenure, current tenure, jobs/year, overdue?). These ride alongside the profile into the rubric.

### 5. Score readiness

For each fetched candidate, run the rubric: read the profile and the computed facts, reason briefly (their change cadence vs current tenure, signs of stagnation vs growth, whether the target role is a real step up), then score each pull and anchor field `0–100` with a one-line justification. Apply the consistency rules. Average a second pass if you ran one.

### 6. Compute readiness and rank

Compute `readiness` from the weighted formula and sort descending. State the weights used.

### 7. Present the outreach list

```markdown
# Outreach priority: [Role] @ [Company] — [N] scored, [M] unscored

**Weights:** [default | custom — note overrides]

| Rank | Candidate | Readiness | Open to work? | Why (evidence) |
|------|-----------|-----------|---------------|----------------|
| 1 | [Name](profile-url) | 81 | yes | 4.5 yrs in role vs 2-yr avg cadence; no promotion since 2022; target role is a clear step up |
| 2 | [Name](profile-url) | 73 | — | Plateaued as senior IC; same scope 3 yrs; team reorg signals |
| … | | | | |

## Unscored (unfetchable profiles)
- [url] — robots-blocked
- [url] — fetch returned no usable text
```

Link each name to its profile URL. Keep the **open-to-work** column separate from the score. State plainly that the score ranks **readiness to move, not candidate quality**, and is decision support for a human sourcer. List unfetchable candidates separately.

If the user wants a shareable view, build a **read-only leaderboard** following talent pool rendering (`references/talent-pool.md`, feed it the readiness scores + rubric breakdowns). No outreach, no profile writes from this ranking step — drafting messages is `draft-outreach`'s job.

## Notes

- **Relative within one run.** Don't compare raw readiness scores across runs or roles.
- **No demographic features.** Score on career-signal evidence only; never infer or use protected attributes.
- **Readiness ≠ fitness, again.** Keep saying it in the output — it's the most common misread of this ranking.
- **Show the reasoning.** Each score carries its evidence; that transparency is the point.
