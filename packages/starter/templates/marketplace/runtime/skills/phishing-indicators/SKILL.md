---
name: phishing-indicators
description: The phishing-report triage runbook — how to check headers, links, and attachments on a reported email against {{report_query}}, classify the risk, and post a verdict with a recommended action to {{security_channel}}. Analyze and recommend only; never block, delete, or remediate.
---

<skill name="phishing-indicators">

<overview>
Every email reported to the phishing-report inbox gets the same disciplined
look: authentication, sender identity, links, and attachments, combined into a
risk tier and a recommended action. A scheduled check spawns a fresh session
with read-only access to Gmail; this skill is the standard the analysis is
done to, so the agent doesn't reinvent the checks or the tiering on every run.
A single check can turn up several reports at once — triage each as an
independent unit; a hard case never blocks the rest. Nothing is ever blocked,
deleted, or changed as a result of this skill — a Slack post is the only
output.
</overview>

<when-to-load>
- The scheduled inbox check fires and there are new reports in
  `{{report_query}}`.
- A human asks why a specific reported email got the verdict it did.
- A human asks the agent to re-analyze a specific reported email on demand.
</when-to-load>

<workflow>

## Step 1 — Pull what's new

Search the phishing-report Gmail inbox with `{{report_query}}` for messages
reported since the last check. Read each one in full, including the original
message it wraps if it was forwarded — the reported wrapper email itself is
rarely the attack; the forwarded original is.

## Step 2 — Check the headers

For the original (forwarded) message, inspect:

| Check | What to look for |
|---|---|
| SPF / DKIM / DMARC | Any result other than a clean pass on all three is a signal, not proof by itself |
| Reply-To vs. From | A Reply-To that doesn't match the From domain, especially to a free-mail or lookalike domain |
| Return-Path | A Return-Path domain unrelated to the claimed sender |
| Display name vs. address | A trusted display name ("IT Helpdesk") paired with an unrelated or misspelled address |
| Routing headers | Received chain hopping through unexpected countries or unrelated infrastructure for an internal-looking sender |

## Step 3 — Check the links

For every link in the body:

- Resolve it to its actual destination — don't trust the display text; a link
  that reads `microsoft.com` can point anywhere.
- Flag lookalike domains (character substitution, added words, wrong TLD),
  URL shorteners, and raw IP-address links.
- Flag any destination that resembles a login page for an internal system,
  especially one asking for credentials or MFA codes.
- A benign, well-known domain with a legitimate path is not itself a signal.

## Step 4 — Check the attachments

- Identify the attachment's real type (magic bytes / content), not just its
  extension — a `.pdf` that's actually an executable or a macro-enabled
  document is a strong signal.
- Flag macro-enabled Office formats, script files, disk images, and any
  archive that requires a password given only in the email body (a common
  evasion for content scanners).
- No attachment is not itself reassuring — credential-harvesting links don't
  need one.

## Step 5 — Classify the risk

Combine the signals into one tier:

| Tier | Criteria |
|---|---|
| **Critical** | Credential-harvesting link or malicious attachment, spoofed authentication, actively impersonating an internal system or executive |
| **High** | Clear lookalike domain or header spoofing plus a suspicious link or attachment, but not yet confirmed credential harvesting |
| **Medium** | One or two suspicious indicators (e.g. authentication soft-fail plus an unusual link) without a clear malicious payload |
| **Low** | Minor anomalies (e.g. a marketing email with an aggressive tone) that don't indicate targeted attack |
| **Benign** | Clean authentication, legitimate sender and links, no attachment concerns — a false report |

Back every tier with the specific indicators found; don't assign a tier on
tone or gut feel alone.

## Step 6 — Draft the verdict and recommended action

Write a short verdict: the tier, the indicators that drove it, and one
recommended action:

- **Block this sender** — for critical/high reports with a clearly malicious,
  reusable indicator (a spoofed domain, a confirmed bad link).
- **Warn staff** — when the same sender or link may have reached others, note
  who's likely affected and suggest a heads-up.
- **No action needed** — for low/benign reports; say so plainly so security
  doesn't waste time re-checking it.

## Step 7 — Post to Slack and stop

Post the verdict to **{{security_channel}}**: tier, indicators, recommended
action, and a link back to the reported thread. That post is the only output.
There's no ledger to update — the next scheduled check re-reads whatever the
inbox looks like then.

</workflow>

<guardrails>
- **Analyze, recommend, alert — nothing else.** The agent never blocks a
  sender, deletes or quarantines a message, or changes anything in Gmail or
  any other system. The recommended action is a suggestion for a person on
  security to carry out.
- **No memory between runs.** Each check is a fresh session; the current
  inbox state is the only source of truth, not what a prior run concluded.
- **Don't inflate the tier.** A report that's genuinely low-risk gets marked
  low-risk — a habit of crying wolf makes the real critical alerts easier to
  ignore.
- **Scoped secrets.** Gmail access is brokered through a read-only connector;
  no raw token is ever shown to the model or written to logs.
- **People decide, not the agent.** Whether a sender actually gets blocked or
  staff actually get warned is a human call on the security team, every time.
</guardrails>

</skill>
