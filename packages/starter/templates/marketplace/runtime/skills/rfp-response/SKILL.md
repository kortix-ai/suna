---
name: rfp-response
description: Fresh-session RFP and proposal-questionnaire response for {{projectName}}. Parses a new inbound RFP from {{rfp_label}} in Gmail and its attached document in Google Drive, matches each question to our vetted past-answers library and product docs, drafts the full response in a new Google Doc inside {{drafts_folder}}, flags anything it can't answer confidently, and leaves an unsent Gmail draft linking it — holding the completed response for a human to review and submit.
---

<skill name="rfp-response">

<overview>
Give a new inbound RFP or proposal questionnaire its full draft response as soon
as it lands: parse every question out of whatever document it arrived in, match
each one against our vetted past-answers library and current product docs, draft
the response in a new Google Doc, and flag anything without a confident match.
Each RFP runs in its own fresh session — one RFP, one sandbox, nothing carried
over — so this skill finds its own state from the Gmail thread and Drive rather
than a ledger.

Reactive and knowledge-base-grounded; the agent drafts and flags, it never
decides what gets submitted to the buyer. This is a general sales RFP/proposal
skill — pricing, implementation, integrations, support, company background,
references. It is distinct from `questionnaire-response`, which is scoped to
security-specific questionnaires (SIG, CAIQ).
</overview>

<when-to-load>
- The 15-minute polling cron fires and finds an RFP or proposal questionnaire in
  {{rfp_label}} that hasn't been drafted yet.
- A human asks the agent for a first-pass draft of a specific RFP.
- Someone asks what our vetted answer is for a specific RFP topic or question.
</when-to-load>

<workflow>

## Step 0 — Find what's new

```
# List messages in the RFP label/folder, newest first.
gmail.messages.list(label={{rfp_label}}, order="newest")

# Check each thread for an existing draft reply — a thread that already has
# one has already been worked.
gmail.drafts.list(thread=message.thread_id)
```

There is no ledger — this is a fresh session per RFP. The Gmail thread itself is
the record of what's already been drafted. A thread with no draft is new; work
the oldest unhandled one first, respecting any stated submission deadline.

## Step 1 — Parse the RFP into individual questions

- Pull the attachment or linked file from the thread (Word doc, PDF, or
  spreadsheet) and open it from `google_drive`.
- Read the whole document — some RFPs spread sections (pricing, technical,
  implementation, references, …) across separate tabs or headings.
- Extract each row or item as a discrete question, keeping its section, item
  number, and exact wording. Note the source format and structure so the draft
  can mirror it.

## Step 2 — Match each question to the vetted library

Work question by question against our approved past answers and product docs,
carried as skills and memory until the team updates them:

| Question topic | Vetted source | Typical confidence |
|---|---|---|
| Pricing tiers / packaging | `.kortix/memory/rfp-answers.md#pricing` | High — exact match |
| Implementation timeline & onboarding | `.kortix/memory/rfp-answers.md#implementation` | High |
| Product capabilities / integrations | `.kortix/memory/rfp-answers.md#product` + live product docs | High — verify against current docs |
| Support model & SLAs | `.kortix/memory/rfp-answers.md#support` | High |
| Company background & references | `.kortix/memory/rfp-answers.md#company` | High |
| Security or compliance basics | `.kortix/memory/rfp-answers.md#security-basics` | Medium — a full security review belongs to the `questionnaire-response` skill, not this one |
| Anything with no matching entry | — | Flag for a person |

A "confident match" means the question maps clearly to one vetted entry, and for
product-capability questions, the vetted entry still matches the current product
docs. If a question is a close paraphrase of a vetted one, use the vetted answer
as written; if it combines two topics, compose from the matching entries rather
than inventing new language. If the library has no entry for a topic, that is a
flag, not an opening to reason from first principles.

## Step 3 — Draft the response in a new Google Doc

Create a new Google Doc inside {{drafts_folder}}, titled with the buyer/RFP name
and date. Mirror the RFP's own question order and section headings so the
reviewer can follow it next to the source document. Write each matched answer in
full under its question, using the vetted wording — adapt only for length or
tone the document calls for, never the substance.

## Step 4 — Flag low-confidence questions

For every question from Step 2 with no confident match, mark it clearly in the
draft (a highlighted heading, a `[NEEDS REVIEW]` tag, or a comment) and add it to
a running list at the top of the doc: item reference, the question text, and why
it isn't answered from the vetted library.

## Step 5 — Leave a draft reply, never send

Reply on the original Gmail thread with a **draft** (never sent) linking the new
Google Doc and summarizing what was answered and what's flagged. The agent never
calls send and never uploads anything to a buyer portal.

## Step 6 — Stop and hand off

The run ends here. A person opens the linked Google Doc, reviews every answer,
resolves the flagged questions, and submits the RFP through whatever channel the
buyer requires — portal, email, or otherwise. That submission never happens in
this session.

</workflow>

<guardrails>
- **Draft only, never submitted.** The response lives in a Google Doc and an
  unsent Gmail draft; the agent never sends, never uploads to a portal, and
  never contacts the buyer directly.
- **Grounded answers only.** Every drafted response traces to an entry in the
  vetted past-answers library (cross-checked against current product docs for
  product-capability questions); if there's no entry, that's a flag, not an
  invented answer.
- **One RFP, one session.** No cross-run ledger — re-derive state from Gmail and
  Drive each time, and never re-draft a thread that already has a draft
  response.
- **Source document is read-only.** Read the RFP attachment from Drive; never
  overwrite, delete, or move it. The response lives in a separate new Doc.
- **Secrets scoped.** Gmail, Google Drive, and Google Docs access is brokered
  server-side; no credential is ever shown to the model or written to a log.
</guardrails>

</skill>
