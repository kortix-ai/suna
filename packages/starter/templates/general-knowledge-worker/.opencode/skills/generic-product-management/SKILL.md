---
name: generic-product-management
description: "Generic starter template — you are an expert product manager. You help write PRDs and feature specs, build and prioritize roadmaps, define and track product metrics, synthesize user research into insights, and communicate clearly with stakeholders across engineering, leadership, and customers."
defaultProjectInstall: true
---

> **TODO — make this yours.** This is a generic starting template. Edit it to fit your own product operation: your PRD template and requirements bar, your prioritization framework, your roadmap format and cadence, and your metrics/OKR stack. Delete what you don't use.

# Product Management Skill

Covers the core PM workflow end to end: turning research into insights, insights into specs, specs into a prioritized roadmap, tracking whether shipped work moved the metrics, and communicating all of it to the right audience in the right format.

## Feature Specs & PRDs

### PRD Structure

A well-structured PRD follows this template:

**1. Problem Statement**
- Describe the user problem in 2-3 sentences
- Who experiences this problem and how often
- What is the cost of not solving it (user pain, business impact, competitive risk)
- Ground this in evidence: user research, support data, metrics, or customer feedback

**2. Goals**
- 3-5 specific, measurable outcomes this feature should achieve
- Each goal should answer: "How will we know this succeeded?"
- Distinguish between user goals (what users get) and business goals (what the company gets)
- Goals should be outcomes, not outputs ("reduce time to first value by 50%" not "build onboarding wizard")

**3. Non-Goals**
- 3-5 things this feature explicitly will NOT do
- Adjacent capabilities that are out of scope for this version
- For each non-goal, briefly explain why it is out of scope (not enough impact, too complex, separate initiative, premature)
- Non-goals prevent scope creep during implementation and set expectations with stakeholders

**4. User Stories**
Write user stories in standard format: "As a [user type], I want [capability] so that [benefit]"

Guidelines:
- The user type should be specific enough to be meaningful ("enterprise admin" not just "user")
- The capability should describe what they want to accomplish, not how
- The benefit should explain the "why" — what value does this deliver
- Include edge cases: error states, empty states, boundary conditions
- Include different user types if the feature serves multiple personas
- Order by priority — most important stories first

Example:
- "As a team admin, I want to configure SSO for my organization so that my team members can log in with their corporate credentials"
- "As a team member, I want to be automatically redirected to my company's SSO login so that I do not need to remember a separate password"
- "As a team admin, I want to see which members have logged in via SSO so that I can verify the rollout is working"

**5. Requirements**

- **Must-Have (P0)**: The feature cannot ship without these — the minimum viable version. Ask: "If we cut this, does the feature still solve the core problem?" If no, it is P0.
- **Nice-to-Have (P1)**: Significantly improves the experience but the core use case works without them. Often become fast follow-ups after launch.
- **Future Considerations (P2)**: Explicitly out of scope for v1 but we want to design in a way that supports them later. Documenting these prevents accidental architectural decisions that make them hard later.

For each requirement: write a clear, unambiguous description of expected behavior; include acceptance criteria (see below); note technical considerations or constraints; flag dependencies on other teams or systems.

**6. Success Metrics** — see [Metrics](#metrics--tracking) below.

**7. Open Questions**
- Questions that need answers before or during implementation
- Tag each with who should answer (engineering, design, legal, data, stakeholder)
- Distinguish blocking questions (must answer before starting) from non-blocking (can resolve during implementation)

**8. Timeline Considerations**
- Hard deadlines (contractual commitments, events, compliance dates)
- Dependencies on other teams' work or releases
- Suggested phasing if the feature is too large for one release

### User Story Writing

Good user stories are INVEST: **I**ndependent, **N**egotiable, **V**aluable, **E**stimable, **S**mall, **T**estable.

Common mistakes:
- Too vague: "As a user, I want the product to be faster" — what specifically should be faster?
- Solution-prescriptive: "As a user, I want a dropdown menu" — describe the need, not the UI widget
- No benefit: "As a user, I want to click a button" — why? What does it accomplish?
- Too large: "As a user, I want to manage my team" — break this into specific capabilities
- Internal focus: "As the engineering team, we want to refactor the database" — this is a task, not a user story

### Requirements Categorization — MoSCoW

- **Must have**: Without these, the feature is not viable. Non-negotiable.
- **Should have**: Important but not critical for launch. High-priority fast follows.
- **Could have**: Desirable if time permits. Will not delay delivery if cut.
- **Won't have (this time)**: Explicitly out of scope. May revisit in future versions.

Tips: be ruthless about P0s — if everything is P0, nothing is P0. Challenge every must-have: "Would we really not ship without this?" P1s should be things you are confident you will build soon, not a wish list. P2s are architectural insurance.

### Acceptance Criteria

Write in Given/When/Then format or as a checklist:

**Given/When/Then**:
- Given [precondition or context]
- When [action the user takes]
- Then [expected outcome]

Example: Given the admin has configured SSO for their organization / When a team member visits the login page / Then they are automatically redirected to the organization's SSO provider.

**Checklist format**:
- [ ] Admin can enter SSO provider URL in organization settings
- [ ] Team members see "Log in with SSO" button on login page
- [ ] SSO login creates a new account if one does not exist
- [ ] SSO login links to existing account if email matches
- [ ] Failed SSO attempts show a clear error message

Tips: cover the happy path, error cases, and edge cases; be specific about expected behavior, not implementation; include what should NOT happen; each criterion should be independently testable; avoid ambiguous words ("fast", "user-friendly", "intuitive") — define what these mean concretely.

### Scope Management

Scope creep happens when requirements keep getting added after the spec is approved, "small" additions accumulate into a significantly larger project, the team builds features no user asked for ("while we're at it..."), the launch date keeps moving without explicit re-scoping, or stakeholders add requirements without removing anything.

Preventing it:
- Write explicit non-goals in every spec
- Require that any scope addition comes with a scope removal or timeline extension
- Separate "v1" from "v2" clearly in the spec
- Review the spec against the original problem statement — does everything serve it?
- Time-box investigations: "If we cannot figure out X in 2 days, we cut it"
- Create a "parking lot" for good ideas that are not in scope

## Roadmap Planning & Prioritization

### Roadmap Formats

**Now / Next / Later** — the simplest and often most effective format:
- **Now** (current sprint/month): Committed work, high confidence in scope and timeline.
- **Next** (next 1-3 months): Planned, scoped, and prioritized but not yet started.
- **Later** (3-6+ months): Directional strategic bets; scope and timing are flexible.
Use for most teams, most of the time — especially external/leadership communication, since it avoids false precision on dates.

**Quarterly Themes** — organize around 2-3 themes per quarter (e.g., "Enterprise readiness"), each mapped to company/team OKRs, with specific initiatives listed under each. Good for showing strategic alignment in planning meetings and executive communication.

**OKR-Aligned Roadmap** — start from the team's OKRs, list initiatives under each Key Result with expected impact. Creates clear accountability between what you build and what you measure. Best for organizations that run on OKRs.

**Timeline / Gantt View** — calendar-based, shows start/end dates, parallelism, sequencing, and dependencies. Good for execution planning with engineering; NOT good for external communication (creates false precision).

### Prioritization Frameworks

**RICE Score** = (Reach x Impact x Confidence) / Effort
- Reach: concrete number of users/customers affected in a period (e.g., "500 users/quarter")
- Impact: 3 = massive, 2 = high, 1 = medium, 0.5 = low, 0.25 = minimal
- Confidence: 100% = high (data-backed), 80% = medium (some evidence), 50% = low (gut feel)
- Effort: person-months across engineering, design, and other functions
Use for quantitative, defensible prioritization across a large backlog; less good for strategic bets where impact is hard to estimate.

**MoSCoW** (see also Feature Specs above) — Must/Should/Could/Won't have. Good for scoping a release or quarter and forcing prioritization conversations with stakeholders.

**ICE Score** = Impact x Confidence x Ease (each scored 1-10; Ease is inverse of effort). Simpler than RICE — good for quick prioritization, early-stage products, or when data is thin.

**Value vs Effort Matrix** — 2x2 plot:
- High value / Low effort: Quick wins — do these first.
- High value / High effort: Big bets — plan carefully, worth the investment.
- Low value / Low effort: Fill-ins — do when there's spare capacity.
- Low value / High effort: Money pits — do not do these.
Good for visual prioritization in team planning sessions and building shared understanding of tradeoffs.

### Dependency Mapping

Categories to check: **technical** (Feature B needs infra from Feature A), **team** (needs design/platform/data work), **external** (vendor/partner/third-party), **knowledge** (needs research first), **sequential** (must ship A before starting B).

Managing dependencies: list them explicitly, assign an owner to each, set a "need by" date, build buffer around them (they are the highest-risk items on any roadmap), flag cross-team dependencies early, and have a contingency plan for slips.

Reducing dependencies: build a simpler version that avoids it; parallelize via an interface contract or mock; resequence to surface the dependency earlier; absorb the work into your team to remove cross-team coordination.

### Capacity Planning

Estimating capacity: start with engineer-count x time period, subtract known overhead (meetings, on-call, interviews, holidays, PTO). Rule of thumb: engineers spend 60-70% of time on planned feature work. Factor in ramp time for new members.

A healthy allocation for most product teams:
- **70% planned features** — roadmap items advancing strategic goals
- **20% technical health** — tech debt, reliability, performance, DX
- **10% unplanned** — buffer for urgent issues, quick wins, cross-team requests

Adjust by context: new product → more feature work; mature product → more tech debt/reliability; post-incident → more reliability; rapid growth → more scalability/performance.

If roadmap commitments exceed capacity, something must give — solve by cutting scope, not by pretending people can do more. When adding to the roadmap, always ask "what comes off?" Better to commit to fewer things and deliver reliably than to overcommit and disappoint.

### Communicating Roadmap Changes

Common triggers: new strategic priority from leadership, research/feedback that shifts priorities, technical discovery that changes estimates, a dependency slip, a resource change, or a competitive move.

How to communicate:
1. Acknowledge the change directly
2. Explain the reason — what new information drove this decision
3. Show the tradeoff — what got deprioritized or is slipping
4. Show the new plan
5. Acknowledge impact — tell affected stakeholders directly, don't let them find out secondhand

Avoid roadmap whiplash: don't change the roadmap for every new piece of information; batch updates at natural cadences (monthly/quarterly) unless something is truly urgent; distinguish "roadmap change" (strategic reprioritization) from "scope adjustment" (normal execution refinement); frequent changes may signal unclear strategy, not good responsiveness.

## Metrics & Tracking

### Product Metrics Hierarchy

**North Star Metric** — the single metric that best captures the core value delivered to users. Should be value-aligned, leading (predicts long-term business success), actionable (team can influence it), and understandable company-wide.

Examples by product type: collaboration tool → weekly active teams with 3+ contributors; marketplace → weekly transactions completed; SaaS → weekly active users completing core workflow; content platform → weekly engaged reading/viewing time; developer tool → weekly deployments using the tool.

**L1 Metrics (Health Indicators)** — 5-7 metrics mapping to the user lifecycle:
- **Acquisition**: new signups/trial starts, signup conversion rate, channel mix, cost per acquisition
- **Activation**: activation rate, time to activate, setup completion rate, first value moment
- **Engagement**: DAU/WAU/MAU, DAU/MAU stickiness ratio, core action frequency, session depth, feature adoption
- **Retention**: D1/D7/D30 retention, cohort retention curves, churn rate, resurrection rate
- **Monetization**: free-to-paid conversion, MRR/ARR, ARPU/ARPA, expansion revenue, net revenue retention
- **Satisfaction**: NPS, CSAT, support ticket volume/resolution time, app store ratings/sentiment

**L2 Metrics (Diagnostic)** — used to investigate L1 changes: funnel conversion per step, feature-level usage, segment breakdowns (plan, company size, geography, role), performance metrics (load time, error rate, latency), content-specific engagement.

### Common Product Metrics

**DAU/WAU/MAU**: Define "active" carefully (login? page view? core action?) — different definitions tell different stories. DAU/MAU ratio (stickiness): above 0.5 = daily habit, below 0.2 = infrequent usage. Trend matters more than the absolute number. Segment by user type.

**Retention**: % of users from period X still active in period Y. Common windows: D1 (was the first experience good?), D7 (habit established?), D30 (retained long-term?), D90 (durable user?). Plot retention curves by cohort — look for initial drop-off (activation problem), steady decline (engagement problem), or flattening (good, stable base). Compare cohorts over time and segment by activation behavior.

**Conversion**: % moving from one funnel stage to the next (visitor→signup, signup→activation, free→paid, trial→paid, monthly→annual). Map the full funnel, find the biggest drop-off points, segment by source/plan/user type, track over time.

**Activation**: % of new users reaching the moment they first experience core value. Define it by comparing retained vs churned users — what did retained users do that churned users didn't? Should be achievable within the first session or first few days. Track per cohort, measure time to activate, build onboarding toward it, and A/B test flows against retention (not just activation rate).

### Goal Setting — OKRs

**Objectives**: qualitative, aspirational, time-bound, directional (not metric-specific).
**Key Results**: quantitative, specific, time-bound, outcome-based (not output-based), 2-4 per Objective.

```
Objective: Make our product indispensable for daily workflows

Key Results:
- Increase DAU/MAU ratio from 0.35 to 0.50
- Increase D30 retention for new users from 40% to 55%
- 3 core workflows with >80% task completion rate
```

Best practices: ambitious but achievable (70% completion is the target for stretch OKRs); KRs measure outcomes, not outputs; 2-3 objectives with 2-4 KRs each is plenty; OKRs should be uncomfortable; review at mid-period and adjust effort allocation; grade honestly (0.0-0.3 missed, 0.4-0.6 progress, 0.7-1.0 achieved).

Setting targets: establish a reliable **baseline**; use **benchmarks** from comparable products; account for current **trajectory** (don't set an unambitious target on top of an already-improving trend); scale ambition to **effort**/investment; set a "commit" and a "stretch" based on **confidence**.

### Metric Review Cadences

- **Weekly** (15-30 min, PM + eng lead): North Star WoW change, key L1 movements, active experiments, anomalies, alerts. Investigate anything that looks off.
- **Monthly** (30-60 min, product team + key stakeholders): full L1 scorecard with MoM trends, progress vs quarterly OKRs, cohort analysis, recent-launch adoption, segment divergence. Identify 1-3 areas to invest in.
- **Quarterly Business Review** (60-90 min, product/eng/design/leadership): OKR scoring, quarter-long trend analysis, YoY comparisons, competitive context. Set next quarter's OKRs and adjust strategy.

### Dashboard Design

Principles: design backwards from the decision the dashboard supports; put the most important metric most visually prominent (North Star → L1 → L2 on drill-down); always show context (current value, comparison to previous period/target/benchmark, trend direction); fewer metrics, more insight (5-10, not 50); consistent time periods across the dashboard; color status (green = on track, yellow = needs attention, red = off track); every metric must be actionable by the team or it doesn't belong.

Suggested layout: top row North Star + trend + target; second row L1 scorecard; third row key funnels; fourth row recent experiments/launches; bottom drill-down for L2/segments/time series.

Anti-patterns: vanity metrics (total signups ever); too many metrics (requires scrolling); no comparison (raw numbers, no context); stale dashboards; output dashboards (tickets closed, PRs merged instead of user/business outcomes); one dashboard trying to serve execs, PMs, and engineers alike.

Alerting: threshold alerts (metric crosses a critical line), trend alerts (sustained decline), anomaly alerts (deviation from expected range). Every alert must be actionable, owned, regularly tuned, and appropriately severity-leveled.

## Stakeholder Communication

### Update Templates by Audience

**Executive / Leadership** — want strategic context, progress vs goals, risks needing their help, decisions needing their input.
```
Status: [Green / Yellow / Red]
TL;DR: [One sentence — the most important thing to know]
Progress:
- [Outcome achieved, tied to goal/OKR]
- [Milestone reached, with impact]
- [Key metric movement]
Risks:
- [Risk]: [Mitigation plan]. [Ask if needed].
Decisions needed:
- [Decision]: [Options with recommendation]. Need by [date].
Next milestones:
- [Milestone] — [Date]
```
Tips: lead with the conclusion, not the journey; keep under 200 words; status color reflects genuine assessment (Yellow is good risk management, not failure); only surface risks you want help with; asks must be specific ("Decision on X by Friday", not "support needed").

**Engineering Team** — want clear priorities, technical context, blockers resolved, decisions affecting their work.
```
Shipped:
- [Feature/fix] — [Link to PR/ticket]. [Impact if notable].
In progress:
- [Item] — [Owner]. [Expected completion]. [Blockers if any].
Decisions:
- [Decision made]: [Rationale]. [Link to ADR if exists].
- [Decision needed]: [Context]. [Options]. [Recommendation].
Priority changes:
- [What changed and why]
Coming up:
- [Next items] — [Context on why these are next]
```
Tips: link to tickets/PRs/docs; explain why when priorities change; be explicit about blockers and unblock plans; don't waste their time on irrelevant info.

**Cross-Functional Partner** (design, marketing, sales, support) — want what's coming that affects them, what to prepare, how to give input.
```
What's coming:
- [Feature/launch] — [Date]. [What this means for your team].
What we need from you:
- [Specific ask] — [Context]. By [date].
Decisions made:
- [Decision] — [How it affects your team].
Open for input:
- [Topic we'd love feedback on] — [How to provide it].
```

**Customer / External** — want what's new, what's coming, benefit, how to get started.
```
What's new:
- [Feature] — [Benefit in customer terms]. [How to use it / link].
Coming soon:
- [Feature] — [Expected timing]. [Why it matters to you].
Known issues:
- [Issue] — [Status]. [Workaround if available].
Feedback:
- [How to share feedback or request features]
```
Tips: no internal jargon or ticket numbers; frame everything as what the customer can now DO; be honest about timelines without overcommitting ("later this quarter" beats a date you might miss); only mention known issues that are customer-impacting and have a resolution plan.

### Status Reporting — Green / Yellow / Red

- **Green (On Track)**: progressing as planned, no significant risks/blockers, on track for commitments. Use only when genuinely true, not as a default.
- **Yellow (At Risk)**: slower than planned or a risk has materialized; mitigation underway but outcome uncertain; may miss commitments without intervention. Flag proactively — the earlier, the more options you have.
- **Red (Off Track)**: significantly behind, major blocker without clear mitigation, will miss commitments without significant intervention. Use when you genuinely need help — don't wait until it's too late.

Move to Yellow at the first sign of risk. Move to Red once you've exhausted your own options. Move back to Green only when the risk is genuinely resolved, not just paused. Document what changed when status changes ("Moved to Yellow because...").

### Risk Communication — ROAM

- **Resolved**: no longer a concern — document how.
- **Owned**: acknowledged, someone actively managing it — state owner and mitigation plan.
- **Accepted**: known, proceeding without mitigation — document the rationale.
- **Mitigated**: actions have reduced it to an acceptable level — document what was done.

Effective risk communication: state the risk clearly ("There is a risk that X because Y"); quantify impact; state likelihood with evidence; present the mitigation; make a specific ask. Common mistakes: burying risks in good news, being vague ("might be some delays"), presenting risks with no mitigation, waiting too long (a risk raised early is a planning input; raised late, it's a fire drill).

### Decision Documentation (ADRs)

```
# [Decision Title]

## Status
[Proposed / Accepted / Deprecated / Superseded by ADR-XXX]

## Context
What is the situation that requires a decision? What forces are at play?

## Decision
What did we decide? State the decision clearly and directly.

## Consequences
What are the implications of this decision?
- Positive consequences
- Negative consequences or tradeoffs accepted
- What this enables or prevents in the future

## Alternatives Considered
What other options were evaluated?
For each: what was it, why was it rejected?
```

Write ADRs for: strategic product decisions, significant technical decisions (architecture, vendor, build vs buy), controversial decisions where people disagreed, decisions that constrain future options, decisions you expect to be questioned later. Write them close to the decision, include who was involved and who made the final call, document context generously, and keep them short — one page beats five.

### Meeting Facilitation

**Stand-up / Daily Sync** (15 min): accomplished since last sync, working on next, blockers. Focus on blockers — the highest-value part. Track and follow up on them. Cancel if there's nothing to sync.

**Sprint / Iteration Planning**: review what shipped/carried over/was cut → set priorities → assess capacity (account for PTO, on-call, meetings) → commit to backlog items that fit → flag dependencies. Come with a proposed priority order; push back on overcommitment; ensure every item has an owner and acceptance criteria.

**Retrospective**: set the stage (psychological safety) → gather data (what went well/not well/confusing) → generate insights (patterns, root causes) → decide 1-3 actions → close. Focus on systems, not individuals. Follow up on previous action items or people disengage.

**Stakeholder Review / Demo**: remind of the goal → demo the real product (not slides) → share metrics/feedback → structured Q&A → next steps and next review date. Frame feedback collection specifically ("What feedback do you have on X?"); capture it visibly and commit to addressing it or explaining why not.

## User Research Synthesis

### Research Synthesis Methodology

**Thematic Analysis** (core method for qualitative research):
1. Familiarization — read through all data before coding
2. Initial coding — tag observations/quotes with descriptive codes; be generous, easier to merge than split later
3. Theme development — group related codes into candidate themes
4. Theme review — check each theme has sufficient evidence, themes are distinct, and together tell a coherent story
5. Theme refinement — define and name each theme with a 1-2 sentence description
6. Report — write up themes as findings with supporting evidence

**Affinity Mapping** (collaborative grouping method):
1. Capture each distinct observation/quote/data point as a separate note
2. Cluster related notes by similarity — let categories emerge, don't pre-define them
3. Label each cluster with a descriptive name
4. Organize clusters into higher-level groups if patterns emerge
5. Identify themes from the clusters and their relationships

Tips: one observation per note; move notes between clusters freely (first grouping is rarely best); split clusters that get too large; outliers are interesting, don't force-fit them; the grouping process itself builds shared understanding.

**Triangulation** — strengthen findings by combining sources:
- Methodological: same question, different methods (interviews + survey + analytics)
- Source: same method, different participants/segments
- Temporal: same observation at different points in time

A finding backed by multiple sources/methods is much stronger than one from a single source. When sources disagree, that's interesting — it may reveal different segments or contexts.

### Interview Note Analysis

For each interview, extract:
- **Observations**: what the participant described doing, experiencing, feeling. Distinguish behaviors from attitudes; note context (when/where/with whom/how often); flag workarounds — these are unmet needs in disguise.
- **Direct quotes**: specific, vivid verbatim statements. Attribute to participant type, not name ("Enterprise admin, 200-person team", not "Sarah"). A quote is evidence, not a finding — the finding is your interpretation.
- **Behaviors vs stated preferences**: what people DO often differs from what they SAY. Behavioral observations are stronger evidence. Note contradictions between stated wants and actual workflow.
- **Signals of intensity**: emotional language, frequency of the issue, effort spent on workarounds, consequence when things go wrong.

Cross-interview analysis: look for patterns across participants, note frequency, identify segments, surface contradictions (often reveal meaningful segments), find surprises that challenge prior assumptions.

### Survey Data Interpretation

Quantitative: check response rate (representativeness), look at distribution shape not just averages (bimodal vs normal tell different stories), segment by user group, be cautious of significance on small samples, compare to benchmarks.

Open-ended responses: treat like mini interview notes — code by theme, count frequency, pull representative quotes, watch for themes that appear here but not in structured questions (things you didn't think to ask).

Common mistakes: reporting averages without distributions; ignoring non-response bias; over-interpreting small differences (a 0.1 NPS point is noise); treating Likert scales as interval data; confusing correlation with causation in cross-tabs.

### Combining Qualitative and Quantitative

The qual-quant loop: qualitative first (reveals WHAT and WHY, generates hypotheses) → quantitative validation (reveals HOW MUCH/HOW MANY, tests hypotheses at scale) → qualitative deep-dive (explains unexpected quantitative findings).

Integration strategies: use quant to prioritize qual findings (a theme matters more if usage data shows it affects many users); use qual to explain quant anomalies (a retention drop is a number, interviews reveal it's a confusing onboarding change); present combined evidence: "47% of surveyed users report difficulty with X (survey), and interviews reveal this is because Y (qualitative finding)."

When sources disagree: this is signal, not error. Check if different populations were measured, check if stated preferences (survey) diverge from actual behavior (analytics), check if the quant question captured what you think it captured. Report the disagreement honestly and investigate further rather than picking a side.

### Persona Development

Build personas from research data, not imagination:
1. Identify behavioral patterns — clusters of similar behaviors, goals, contexts
2. Define distinguishing variables (company size, technical skill, usage frequency, primary use case)
3. Create a profile per cluster (see template below)
4. Validate — can you size each persona segment with quantitative data?

```
[Persona Name] — [One-line description]

Who they are:
- Role, company type/size, experience level
- How they found/started using the product

What they are trying to accomplish:
- Primary goals and jobs to be done
- How they measure success

How they use the product:
- Frequency and depth of usage
- Key workflows and features used
- Tools they use alongside this product

Key pain points:
- Top 3 frustrations or unmet needs
- Workarounds they have developed

What they value:
- What matters most in a solution
- What would make them switch or churn

Representative quotes:
- 2-3 verbatim quotes that capture this persona's perspective
```

Common mistakes: demographic personas (age/gender/location) instead of behavioral ones — behavior predicts product needs better; too many personas (3-5 is the sweet spot); fictional personas made up from assumptions; static personas never updated; personas that don't change any product decision.

### Opportunity Sizing

For each finding, estimate: **addressable users** (via analytics/survey/market data), **frequency** (daily/weekly/monthly/one-time), **severity** (blocker/significant friction/minor annoyance), **willingness to pay** (would fixing this drive upgrades, retention, or acquisition?).

Score opportunities:
- Impact = (Users affected) x (Frequency) x (Severity)
- Evidence strength (multiple sources > single source, behavioral data > stated preferences)
- Strategic alignment with company vision
- Feasibility (technical, resource, time to impact)

Presenting: be transparent about assumptions and confidence; show the math ("Based on support ticket volume, ~2,000 users/month encounter this. Interview data suggests 60% consider it a significant blocker."); use ranges, not false precision ("1,500-2,500 users monthly", not "2,137 users monthly"); compare opportunities against each other for a relative ranking, not just absolute scores.
