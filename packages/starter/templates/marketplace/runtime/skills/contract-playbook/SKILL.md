---
name: contract-playbook
description: First-pass contract review for {{contracts_folder}}. Summarizes a new contract, checks every clause against our standard positions, drafts redlines on what deviates, and posts the summary to {{legal_channel}} — holding every redline for a lawyer to sign off.
---

<skill name="contract-playbook">

<overview>
Give a new contract its first pass the moment it lands: read it in full, summarize
it, check it clause-by-clause against our standard positions, draft redlines on
what deviates, and post the readout to legal. Each contract runs in its own fresh
session — one contract, one sandbox, nothing carried over — so this skill has to
find its own state from Drive and Slack rather than a ledger.

Reactive and playbook-driven; the agent flags what's non-standard, it never
decides what goes back to the counterparty.
</overview>

<when-to-load>
- The polling cron fires and finds contracts in {{contracts_folder}} that haven't
  been summarized yet.
- A human asks for a first-pass review of a specific contract.
- A lawyer asks what our standard position is on a clause type.
</when-to-load>

<workflow>

## Step 0 — Find what's new

```
# List files in the contracts folder, newest first.
drive.files.list(folder={{contracts_folder}}, orderBy="createdTime desc")

# Search {{legal_channel}} for a prior summary post referencing each file name.
# A file with a matching post is already handled — skip it.
slack.search(channel={{legal_channel}}, query=file.name)
```

There is no ledger — this is a fresh session per contract. The Slack channel
history *is* the record of what's already been reviewed. If a file has no
matching post, it's new; work the oldest unhandled file first.

## Step 1 — Read the whole contract

Drive finds the file; Docs reads it. Open the document with the Docs API
(`docs.documents.get`) to pull its actual body, not a Drive preview or the
first page. Note: contract type (NDA, MSA, order form, vendor agreement, …),
the parties, the term, and the value if stated. This becomes the top of the
summary.

## Step 2 — Check every clause against our standard positions

Work section by section. Our playbook, until the team updates it via memory:

| Clause | Routine | Flag |
|---|---|---|
| Liability cap | Capped at 12 months' fees | Uncapped, or capped above 12 months' fees |
| Indemnification | Mutual, capped | Unilateral (only us), or uncapped |
| Termination for convenience | Either party, ≤ 90 days notice | Missing, or > 90 days notice |
| Auto-renewal | Opt-in, or opt-out with ≥ 30 days notice | Silent renewal with < 30 days notice |
| Governing law / venue | Our home jurisdiction | Counterparty's jurisdiction or a neutral third one we haven't used before |
| Payment terms | Net 30–45 | Net 60 or longer |
| IP assignment | Foreground IP only | Assigns our background IP or pre-existing tools |
| Confidentiality duration | 3–5 years post-termination | Perpetual, or silent on duration |

Note every deviation with the section reference and a one-line reason. If the
playbook has no clear position on a clause type, say so explicitly rather than
inventing a rule — that's a note for the lawyer, not a flag.

## Step 3 — Draft redlines on the flagged clauses

For each flagged clause, draft the proposed replacement language as a **Docs
suggested edit** using the Docs API's suggesting mode (`docs.documents.batchUpdate`
with the request's `writeControl`/suggester identity set so the change lands as
a suggestion, not an applied edit) — never as a direct write to the document.
Keep the redline close to our standard position (e.g., propose the 12-month cap,
not a negotiating opener). One redline per flagged clause; reference the section
number.

## Step 4 — Write the summary

Plain-English, short:
- What it is, who it's with, the term and value.
- What's routine (one line, or omit if nothing notable).
- What's flagged — each deviation, its section, and why it's non-standard.
- A link to the contract and to the drafted redlines.

## Step 5 — Post to {{legal_channel}}

Post the summary as a single message (or a message + thread if the flag list is
long) to {{legal_channel}}, with the contract link and the redline link. Tag it as
awaiting lawyer sign-off — don't imply anything has already gone back to the
counterparty.

## Step 6 — Stop

The run ends when the summary is posted. Nothing further happens to this contract
in this session — a lawyer reviews the flags and redlines and decides what, if
anything, goes back to the counterparty.

</workflow>

<guardrails>
- **Redlines are drafted, never sent.** Every proposed edit lands as a Docs
  suggestion pending a lawyer's sign-off; the agent never emails, shares, or
  messages a redline to the counterparty.
- **One contract, one session.** No cross-run ledger — re-derive state from Drive
  and {{legal_channel}} each time, and never re-summarize a contract that already
  has a posted summary.
- **Read-only on the source document.** Suggesting-mode edits only, via the Docs
  API; never use Drive to overwrite, delete, or move the original file, and never
  apply a suggestion directly.
- **No invented positions.** If the playbook has no stance on a clause, say so
  instead of guessing what "standard" means.
- **Secrets scoped.** Drive, Docs, and Slack access is brokered server-side; no
  credential is ever shown to the model or written to a log.
</guardrails>

</skill>
