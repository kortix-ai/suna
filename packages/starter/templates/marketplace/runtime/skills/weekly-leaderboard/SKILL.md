---
name: weekly-leaderboard
description: How to build and post the weekly ENG/PRODUCT shipping brief to Slack — a compact summary of what shipped, a ranked merged-PR count per person with week-on-week delta and shipping streaks, and an async standup thread prompt. Load this when you are the `leaderboard` agent (the `weekly-leaderboard` cron), or when someone asks for a weekly contributor/shipping summary.
---

<skill name="weekly-leaderboard">

<overview>
Once a week the operator posts an **ENG/PRODUCT shipping brief** to Slack
{{slack_channel}}: what changed, who drove it, a ranked PR leaderboard with
streaks and deltas, and a standup thread prompt for async input. Git and Slack
are the evidence; the output leads with outcomes but includes hard numbers.

The `leaderboard` agent is a thin wrapper around this skill, fired by the
`weekly-leaderboard` cron in `kortix.yaml`.
</overview>

<window>
Cover the **last 7 days**. Compute the cutoff explicitly:
```sh
since=$(date -u -d '7 days ago' +%Y-%m-%d 2>/dev/null || date -u -v-7d +%Y-%m-%d)
```
If a prior leaderboard post exists in {{slack_channel}}, prefer "since the last
post" so nothing is double-counted or skipped — read it first with `slack history`.
</window>

<sources>
Pull from real data — never invent contributions.

### 1. Merged PRs — counts per person (the leaderboard backbone)

Repos: **{{target_repos}}** (space-separated). Count merged PRs per author in each:
```sh
since=$(date -u -d '7 days ago' +%Y-%m-%d 2>/dev/null || date -u -v-7d +%Y-%m-%d)
for repo in {{target_repos}}; do
  gh pr list --repo "$repo" --state merged --search "merged:>=$since" --limit 200 \
    --json number,title,author,mergedAt,labels
done | jq -s 'add | group_by(.author.login)
  | map({author: .[0].author.login, count: length, prs: map({number,title,mergedAt})})'
```

**Exclusions.** Drop PRs authored by `app/dependabot`, `app/github-actions`,
any `agent-*`, and any login ending in `[bot]`. Count them on a separate line:
*"+ N bot/agent PRs (dependabot ×N, …)"*. Do NOT exclude a PR a human drove even
if an agent helped write it — attribute to the human who opened/merged it.

**Identity map (GitHub login → display name).** Edit this for your team:
```
# githubLogin  ->  Display Name
# alice-gh     ->  Alice
# bob-eng      ->  Bob
```
When in doubt, use the PR author's display-name field.

Also pull commits pushed straight to the default branch (no PR):
```sh
for repo in {{target_repos}}; do
  gh api "repos/$repo/commits?since=${since}T00:00:00Z&per_page=100" --paginate \
    --jq '.[] | {sha: .sha[0:8], author: .commit.author.name, msg: (.commit.message | split("\n")[0])}'
done
```

### 2. Prior week (deltas + streaks)

Read `.kortix/memory/weekly-digests.md` — the `### PR Leaderboard` and
`### Streaks` of the most recent entry — for last week's per-person counts
(compute `+N` / `-N`) and current streak counts.

### 3. Team discussion (context that makes numbers meaningful)
```sh
slack channels --limit 1000
slack history --channel <main-channel-id> --limit 200
slack search --query "shipped after:$since"
```
Capture launches, decisions, blockers, direction changes, shout-outs. Link the
most useful thread. Read last week's standup thread (ts in the ledger).

### 4. Don't double-count
One logical change = one narrative line. The leaderboard counts raw merged PRs;
"What happened" groups them into outcomes.
</sources>

<building>
A brief a founder can read in under 90 seconds and the team wants to open.

**1 — Header** `ENG/PRODUCT weekly — <one-line takeaway>`

**2 — Snapshot** `<n> PRs merged · <n> active shippers · <n> major discussions`

**3 — What happened** (5–7 bullets, ordered by impact):
`• *Area:* outcome → why it mattered — *Owner(s)* (<url|#PR>)`
Lead with outcomes, collapse fixups into one shipped thing, include Slack-only
events. Banned filler: "great", "big week", "kudos", "various improvements".

**4 — PR leaderboard** (from the per-person counts, sorted desc):
```
*PR leaderboard — week of YYYY-MM-DD*
🥇 Alice     ██████  6  (+2)
🥈 Bob       ████    4  (=)
🥉 Carol     ███     3  (-1)
   Dave      ██      2  (new)
+ 12 bot/agent PRs (dependabot ×8, agent ×4)
```
Bar: one `█` per PR, max 10 wide (scale past 10). Delta vs last week
(`+N`/`-N`/`=`, `new` if 0 last week). 🥇🥈🥉 for top 3. Only people with ≥1 PR.
If nobody merged any, skip this and note it in the snapshot.

**5 — Streaks** — for anyone shipping ≥1 PR ≥2 weeks running:
`🔥 Alice — 8-week streak`
Read/update counts from the ledger (increment shippers, reset the rest). Only
show if at least one streak ≥2.

**6 — Standup thread prompt** — post as a **reply** to the main message:
```
🗓 Monday async standup — reply in this thread by EOD

• What did you ship last week? (link PRs or describe)
• Top priority this week?
• Any blockers?

{{team_mentions}}
```

**7 — Slack signal / next watch** — 1–3 bullets for decisions/blockers/asks that
didn't map to a PR.
</building>

<ledger>
After posting, append a `## Week of YYYY-MM-DD` entry to
`.kortix/memory/weekly-digests.md` with: a **PR Leaderboard** table
(Person | PRs | Delta | Streak) + a bot/agent line, a **Streaks** list, the
**standup thread ts** (+ channel id), and short **Product / Decisions / Open
questions** notes. Keep the last **8 weeks**; drop the oldest when you exceed it.
Land it as a self-merged `memory: leaderboard YYYY-WW` CR scoped to that file
only, AFTER posting to Slack (so a Slack failure doesn't block the ledger).
</ledger>

<posting>
Post to {{slack_channel}}. Resolve the id and join if needed:
```sh
chan=$(slack channels --limit 1000 | grep -i "$(echo '{{slack_channel}}' | tr -d '#')" | awk '{print $1}' | head -1)
slack join --channel "$chan" 2>/dev/null || true
```
**Main post:** Block Kit with sections 1–5 + 7. Load `kortix-slack` for the exact
`slack send --channel <id> --blocks-file <path> --text <fallback>` mechanics.
Pass `--channel` explicitly (cron session, no active Slack turn); always include a
plain `--text` fallback. **Standup thread:** capture the sent message `ts`, then
`slack reply --channel "$chan" --thread <ts> --text "<standup prompt>"`; save the
ts to the ledger. If nothing shipped, post one honest line + the standup prompt
anyway — the team still checks in.
</posting>

<guardrails>
- **Real data only.** Every count, delta, and streak traces to `gh pr list`.
- **No secrets / no PII** — link PRs; never paste tokens or customer data.
- **One main post per run.** The standup reply is part of the same run.
- **Attribute fairly.** Bots are excluded from the count and called out
  separately; a human-driven, agent-written PR counts for the human.
- **Streak integrity.** ≥1 merged PR per week, continuous; a missed week resets.
</guardrails>

</skill>
