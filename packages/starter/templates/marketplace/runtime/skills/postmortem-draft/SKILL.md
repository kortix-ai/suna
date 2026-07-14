---
name: postmortem-draft
description: Periodic sweep that finds incidents marked resolved in {{incident_channel}}, correlates the channel timeline against GitHub deploys/merges and Datadog log spikes over the incident window, and drafts a structured postmortem as a PR under {{postmortem_path}} in {{target_repo}} — root cause and action items proposed, never finalized.
---

<skill name="postmortem-draft">

<overview>
Turns a resolved incident into a first-draft postmortem while the details are
still fresh, without ever publishing a conclusion on its own. A periodic
sweep reads {{incident_channel}} for incidents marked resolved, checks
{{target_repo}} for a draft that already exists, and for each new one:
reconstructs the timeline from the channel, lines it up against GitHub
deploys/merges and Datadog error-rate/latency spikes over the same window,
and opens a doc PR under {{postmortem_path}} with a proposed root cause and
candidate action items.

Fresh session per sweep — state lives in {{incident_channel}} (an incident's
resolved marker) and in {{target_repo}} (whether a draft PR/branch already
exists for it), not in a local ledger file.
</overview>

<when-to-load>
- The periodic sweep fires and checks {{incident_channel}} for incidents
  marked resolved.
- A human asks the agent to draft (or re-draft) the postmortem for a
  specific incident.
- A postmortem draft PR needs its timeline extended because new incident
  channel activity or deploy history surfaced after the first draft opened.
</when-to-load>

<workflow>

## Step 0 — Orient: find what's new

Read the recent history of {{incident_channel}} and pull incidents marked
resolved (a "resolved" status change, a closing message, or the incident-bot's
resolution marker — whichever convention the channel uses).

```sh
gh pr list --repo {{target_repo}} --state all \
  --search 'in:title "postmortem:" OR label:postmortem' \
  --json number,title,headRefName,url,state
```

For each resolved incident, check whether a postmortem PR or branch already
exists (title/branch carries the incident id). Skip incidents that already
have one, unless a human asked you to extend it — never open a duplicate
draft for the same incident.

## Step 1 — Pull the incident timeline from the channel

For each new resolved incident, read its full thread in
{{incident_channel}} from open to resolution: who declared it, every status
update, who did what, and the timestamp of each. This is the spine of the
postmortem — every other source gets lined up against it, not the other way
around.

Note the incident's start time and resolved time; that window is what you'll
correlate deploys and log spikes against in the next two steps.

## Step 2 — Correlate GitHub deploys and merges

```sh
cd /workspace/repo || git clone --filter=blob:none https://github.com/{{target_repo}}.git /workspace/repo && cd /workspace/repo
git fetch origin
git log --since="<incident-start>" --until="<incident-resolved>" --oneline --all
gh pr list --repo {{target_repo}} --state merged \
  --search "merged:<incident-start>..<incident-resolved>" \
  --json number,title,mergedAt,url
```

List every merge/deploy that landed in the incident window. A merge shortly
before the first symptom in the channel is the leading suspect for root
cause — but note every candidate, not just the first one.

## Step 3 — Correlate Datadog log spikes

Query Datadog for error-rate and latency spikes over the same window as the
incident (the service(s) named in the channel thread). Pull the metrics that
show *when* the spike started and peaked, not just that one occurred — the
onset time is what lines up against the timeline and the deploys.

## Step 4 — Build the correlated timeline

Merge the three sources into one chronological timeline: channel events,
deploys/merges, and log spikes, all on the same clock. Where a deploy lands
right before a spike which lands right before the first channel report,
that's the causal chain to propose — state it as inferred, with the evidence
listed, not as settled fact.

## Step 5 — Draft the postmortem

Load the existing postmortem format and house style from
{{postmortem_path}} in {{target_repo}} (past postmortems' section layout and
terminology) and write the new one to match it. At minimum, include:

- **Summary** — one paragraph: what broke, user impact, duration.
- **Timeline** — the correlated, timestamped sequence from Step 4.
- **Root cause (proposed)** — the leading causal chain from the evidence,
  explicitly marked as the agent's inference for a human to confirm or
  correct.
- **Impact** — what was affected and for how long, pulled from the channel
  and any metrics referenced there.
- **Action items (candidate)** — concrete follow-ups the evidence suggests
  (a guard rail, a missing alert, a runbook gap), each unassigned — owners
  are for the team to set during review, never the agent.

## Step 6 — Open the PR

```sh
cd /workspace/repo
BRANCH="postmortem/<incident-id>"
git checkout -b "$BRANCH"
git add {{postmortem_path}}
git commit -m "postmortem: draft for <incident-id>"
git push origin "$BRANCH"
gh pr create --repo {{target_repo}} --base main --head "$BRANCH" \
  --title "postmortem: <incident-title> (<incident-id>)" \
  --label postmortem \
  --body "Drafted by the incident postmortem agent from {{incident_channel}},
GitHub deploy history, and Datadog log spikes over the incident window. Root
cause and action items are proposed, not final — a human reviews the
timeline, corrects what was inferred, and owns the merge."
```

One PR per incident. Never push directly to a branch anyone reads from, and
never merge it yourself.

</workflow>

<guardrails>
- **Draft only, never final.** Root cause and action items are always
  presented as proposed inferences, never as the team's settled conclusion.
- **No direct push to `main`.** The agent opens a PR and stops. A human
  reviews, edits, and merges.
- **Never assigns owners or closes the incident.** Action items are
  candidates; assigning them and closing the incident out are for the team.
- **One PR per incident.** Check for an existing draft before opening a new
  one; never duplicate a postmortem for the same incident.
- **Read-only everywhere except the PR.** The incident channel, GitHub
  history, and Datadog are read-only sources; the postmortem PR is the one
  write.
- **Sandbox isolation.** The clone, the correlation, and the draft all happen
  in the session sandbox. Only the PR leaves it.
- **Secrets scoped.** The channel, GitHub, and Datadog credentials are
  injected into the sandbox at runtime, never shown to the model or written
  to logs.
- **No local ledger.** State is read fresh each sweep from the incident
  channel and from {{target_repo}}'s existing PRs/branches — nothing about
  a prior run is assumed.
</guardrails>

</skill>
