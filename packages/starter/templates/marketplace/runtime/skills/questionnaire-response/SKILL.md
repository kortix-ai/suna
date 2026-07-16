---
name: questionnaire-response
description: Fresh-session security questionnaire response for {{projectName}}. Parses a new inbound questionnaire from {{questionnaire_label}} in Gmail, matches each question to our vetted knowledge base of approved answers and policies, drafts responses in the vendor's own format (SIG, CAIQ, or a custom spreadsheet), flags anything it can't answer confidently, and posts the completed draft to {{security_channel}} — holding it for security to review before it goes back to the prospect.
---

<skill name="questionnaire-response">

<overview>
Give a new inbound security questionnaire its full draft the moment it lands: parse
every question out of whatever format it arrived in, match each one against our
vetted knowledge base of approved answers and policies, draft the response back into
the vendor's own layout, and flag anything without a confident match. Each
questionnaire runs in its own fresh session — one questionnaire, one sandbox,
nothing carried over — so this skill finds its own state from the Gmail thread
rather than a ledger.

Reactive and knowledge-base-grounded; the agent drafts and flags, it never decides
what goes back to the prospect.
</overview>

<when-to-load>
- The polling cron fires and finds a questionnaire in {{questionnaire_label}} that
  hasn't been drafted yet.
- A human asks for a first-pass draft of a specific questionnaire.
- Someone asks what our vetted answer is for a specific question or topic.
</when-to-load>

<workflow>

## Step 0 — Find what's new

```
# List messages in the questionnaire label/folder, newest first.
gmail.messages.list(label={{questionnaire_label}}, order="newest")

# Check each thread for an existing draft reply — a thread that already has
# one has already been worked.
gmail.drafts.list(thread=message.thread_id)
```

There is no ledger — this is a fresh session per questionnaire. The Gmail thread
itself is the record of what's already been drafted. A thread with no draft is new;
work the oldest unhandled one first.

## Step 1 — Parse the questionnaire into individual questions

- Pull the attachment from the thread (SIG workbook, CAIQ, or custom spreadsheet).
- Open it with `google_sheets` and read every tab — some vendor formats spread
  sections (encryption, access control, incident response, …) across separate
  sheets.
- Extract each row as a discrete question, keeping its section, row reference, and
  exact wording. Note the vendor format so the draft goes back in the same layout.

## Step 2 — Match each question to the vetted knowledge base

Work question by question against our approved answers and policy docs, carried as
skills and memory until the team updates them:

| Question topic | Vetted source | Typical confidence |
|---|---|---|
| Encryption at rest / in transit | `.kortix/memory/security-answers.md#encryption` | High — exact match |
| SSO / access controls | `.kortix/memory/security-answers.md#access-controls` | High |
| Incident response | `.kortix/memory/security-answers.md#incident-response` | High |
| Data retention & deletion | `.kortix/memory/security-answers.md#data-retention` | High |
| Subprocessors / sub-processing | `.kortix/memory/security-answers.md#subprocessors` | Medium — verify the list is current |
| Compliance standards (SOC 2, ISO 27001, …) | `.kortix/memory/security-answers.md#standards` | High |
| Anything with no matching entry | — | Flag for a person |

A "confident match" means the question maps clearly to one vetted entry. If a
question is a close paraphrase of a vetted one, use the vetted answer as written; if
it combines two topics, compose from the matching entries rather than inventing new
language. If the knowledge base has no entry for a topic, that is a flag, not an
opening to reason from first principles.

## Step 3 — Draft the response in the vendor's own format

Write each matched answer into the corresponding cell/field of the SIG, CAIQ, or
custom spreadsheet — same layout, same tab, same row it came in on. Use the vetted
wording; adapt only for length or formatting the cell requires, never the substance.
Work on a copy of the attachment, never the original file.

## Step 4 — Flag low-confidence questions

For every question from Step 2 with no confident match, mark its row (a flag
column, a comment, or the vendor's own "needs follow-up" field if it has one) and
add it to a running list: row reference, the question text, and why it isn't
answered from the vetted set.

## Step 5 — Draft the reply, never send

Attach the filled spreadsheet to a **Gmail draft** reply on the original thread,
addressed to the sender. Save it as a draft only — never call send. The subject and
body should make clear a completed draft is attached and pending internal review.

## Step 6 — Post to {{security_channel}} and stop

Post one message to {{security_channel}}: a link to the draft, the vendor format,
and the flagged-question list (row reference + question, one line each). If nothing
was flagged, say so explicitly rather than omitting the line. The run ends here — a
person from security reviews the draft, answers the flagged questions, and sends it.

</workflow>

<guardrails>
- **Drafts are never sent.** The filled questionnaire goes back as a Gmail draft on
  the original thread; the agent never calls send and never emails the prospect
  directly.
- **Grounded answers only.** Every drafted response traces to an entry in the vetted
  knowledge base; if there's no entry, that's a flag, not an invented answer.
- **One questionnaire, one session.** No cross-run ledger — re-derive state from
  Gmail each time, and never re-draft a thread that already has a draft reply.
- **Original attachment is read-only.** Fill a copy of the spreadsheet; never
  overwrite, delete, or move the source file.
- **Secrets scoped.** Gmail and Google Sheets access is brokered server-side; no
  credential is ever shown to the model or written to a log.
</guardrails>

</skill>
