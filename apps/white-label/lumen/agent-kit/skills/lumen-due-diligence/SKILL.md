---
name: lumen-due-diligence
description: Due-diligence checklist per document type and the red-flag rubric, for data-room reviews and diligence reports.
---

# Due diligence

## Checklist by document type

| Type | Extract |
|---|---|
| MSA | parties, term and renewal, termination rights, liability cap, indemnities, IP ownership, assignment, governing law |
| SaaS | term and renewal, service levels and remedies, data protection terms, liability cap, change of control, assignment |
| Lease | term, rent and review, break clauses, repair obligations, alienation, service charge |
| Employment | role, notice, restrictive covenants (length, scope), IP assignment, garden leave |
| SPA | price mechanics, escrow or retention, conditions, warranty survival, liability limits, restrictive covenants |
| Supply | exclusivity, pricing (most-favoured-customer), term, liability, change of control, assignment |
| DPA | subprocessors, breach notice, transfers, audit, deletion |
| NDA | term, residuals, non-solicit, governing law |
| Consulting | IP ownership, payment terms, termination, liability |

## Red flags

| Flag | Rule | Severity |
|---|---|---|
| Uncapped liability | No cap, or a cap stated as unlimited | high |
| Change of control | A counterparty's consent or termination right on a change of control | high |
| Exclusivity | Any exclusivity or non-compete binding the target | medium; high if 3 years or more |
| Assignment | Assignment only with consent, in a deal that needs a transfer | medium |
| Non-compete | Longer than 12 months | medium |
| IP ownership | IP in work product stays with a contractor or consultant | high |
| Escalation | Rent or price escalation above 5% per year | medium |
| Repair | A tenant liable for structural repairs | medium |
| Missing DPA | Personal data processed and no data processing terms anywhere in the data room | high; medium when a stand-alone DPA between the same parties is in the room but not attached as the schedule |

Every red flag names the document and cites the clause. A flag you cannot cite is not a flag.

## Cross-references: resolve before you call a document missing

A contract often defines another agreement by name: "the Main Agreement", "Schedule 3", "the
Disclosure Letter". Before a report says that agreement is missing:

1. Read the definition (search for the defined name; read the defining clause).
2. Match it against every document in the data room by type, parties and date.
3. A match is in the data room: name it by filename and cite the definition. Example: a DPA that
   defines "the Main Agreement" as the SaaS agreement between the same two parties points at the
   SaaS agreement in the room.
4. Only when nothing matches, list it under Gaps as "not in the data room", with the citation of
   the clause that refers to it.

## The report (reduce run)

Sections in this order: Overview, Commercial terms, Liability and risk allocation, Change of control and assignment, Employment and IP, Property, Data protection, Gaps. Each section body cites with `/cite?` links. `red_flags` lists each flag once.
