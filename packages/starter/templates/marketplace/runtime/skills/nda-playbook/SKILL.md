---
name: nda-playbook
description: Fast first-pass NDA review for {{nda_label}}. Saves a new inbound NDA into {{nda_folder}}, checks it clause-by-clause against our standard NDA positions, drafts redlines on what deviates, and drafts a flag summary for counsel — holding every redline and flag for counsel's sign-off. Never signs or sends.
---

<skill name="nda-playbook">

<overview>
Turn a new inbound NDA around fast: read it in full, check it clause-by-clause
against our standard NDA positions, redline what deviates, and flag anything
outside the guidelines for counsel. Each NDA runs in its own fresh session — one
NDA, one sandbox, nothing carried over — so this skill finds its own state from
Gmail and Drive rather than a ledger.

Reactive and playbook-driven; the agent redlines and flags, it never decides
what goes back to the counterparty and never signs or executes anything.
</overview>

<when-to-load>
- The 15-minute polling cron fires and finds an NDA in {{nda_label}} that hasn't
  been processed yet.
- A human asks for a first-pass review of a specific NDA.
- Counsel asks what our standard position is on an NDA clause type.
</when-to-load>

<workflow>

## Step 0 — Find what's new

```
# Search Gmail for NDAs under the watched label that look unprocessed.
gmail.threads.list(label={{nda_label}}, query="has:attachment")

# For each candidate thread, check for an existing draft reply on it and an
# existing file in {{nda_folder}} named after the counterparty. Either one
# means it's already been handled — skip it.
gmail.drafts.list(threadId=thread.id)
drive.files.list(folder={{nda_folder}}, query="name contains '<counterparty>'")
```

There is no ledger — this is a fresh session per NDA. Gmail's draft state and
the {{nda_folder}} contents *are* the record of what's already been reviewed.
Work the oldest unhandled thread first.

## Step 1 — Pull the document into Drive and open it

Save the NDA attachment (or the linked file, if it arrived as a share link)
into {{nda_folder}}, named for the counterparty and date. Open it with the
Docs API (`docs.documents.get`) so you're reading the actual body — not the
Gmail preview pane or the first page.

Note the counterparty, whether the NDA is mutual or one-way, the term, and the
effective date. This becomes the top of the flag summary.

## Step 2 — Check every clause against our standard positions

Work section by section. Our playbook, until the team updates it via memory:

| Clause | Routine | Flag |
|---|---|---|
| Type | Mutual | One-way, when we're also disclosing our own confidential info |
| Confidentiality duration | 2–3 years post-disclosure | Perpetual, or silent on duration |
| Governing law / venue | Our home jurisdiction | Counterparty's jurisdiction or an unfamiliar third one |
| Non-solicit | None, or ≤ 12 months, employees only | > 12 months, or extends to customers/contractors |
| Remedies | Standard damages; injunctive relief available to both | One-sided injunctive relief (counterparty only) |
| Residuals clause | Present, standard carve-out for retained general knowledge | Missing, or broad enough to cover specifics, not just recollection |
| Return/destruction of info | Either party, on request or termination, ≤ 30 days | No obligation to return/destroy, or > 30 days |
| Assignment | Requires consent, except to an affiliate/successor | Freely assignable without consent |
| Indemnification | None (standard for an NDA) | Any indemnification obligation placed on us |

Note every deviation with the section reference and a one-line reason. If the
playbook has no clear position on a clause type, say so explicitly rather than
inventing a rule — that's a note for counsel, not a flag.

## Step 3 — Redline the flagged clauses

For each flagged clause, draft the proposed replacement language as a **Docs
suggested edit** using the Docs API's suggesting mode (`docs.documents.batchUpdate`
with the request's `writeControl`/suggester identity set so the change lands as
a suggestion, not an applied edit) — never as a direct write to the document.
Keep the redline close to our standard position (e.g., propose the 2-year term,
not a negotiating opener). One redline per flagged clause; reference the
section number.

## Step 4 — Draft the flag summary for counsel

Draft — never send — a Gmail reply on the original thread, addressed to
counsel:

- What it is: counterparty, mutual or one-way, term, effective date.
- What's routine (one line, or omit if nothing notable).
- What's flagged: each deviation, its section, and why it's non-standard.
- A link to the saved NDA and to the redlined Doc.

## Step 5 — Stop

The run ends when the redline is in the Doc and the flag draft is saved.
Nothing further happens to this NDA in this session — counsel reviews the
redline and the flag summary and decides what, if anything, goes back to the
counterparty, and is the only one who signs, executes, or sends.

</workflow>

<guardrails>
- **Redline and flag only, never sign or execute.** Every proposed edit lands as
  a Docs suggestion pending counsel's sign-off; the agent never signs,
  countersigns, executes, or sends an NDA — or a reply about one — to the
  counterparty.
- **One NDA, one session.** No cross-run ledger — re-derive state from Gmail
  and {{nda_folder}} each time, and never re-process an NDA that already has a
  saved copy or a drafted flag reply.
- **Read-only on the source document.** Suggesting-mode edits only, via the
  Docs API; never use Drive to overwrite, delete, or move the original
  attachment, and never apply a suggestion directly.
- **No invented positions.** If the playbook has no stance on a clause, say so
  instead of guessing what "standard" means.
- **Drafts only in Gmail.** The flag summary is a draft reply on the original
  thread; it is never sent automatically.
- **Secrets scoped.** Gmail, Drive, and Docs access is brokered server-side; no
  credential is ever shown to the model or written to a log.
</guardrails>

</skill>
