---
name: legal-writer
description: "Legal document drafting -- contracts, memos, briefs, complaints, demand letters, opinions, discovery, settlements, ToS, privacy policies. Full pipeline: document structure, per-section writing, Bluebook citation, case law lookup (CourtListener API), regulation lookup (eCFR API), DOCX output, and TDD-style verification (defined terms, cross-references, placeholders, boilerplate, citation format). Triggers on: 'draft a contract', 'write a legal memo', 'create an NDA', 'write a brief', 'legal document about', 'draft a complaint', 'terms of service', 'privacy policy', 'demand letter', 'settlement agreement', 'legal opinion', 'discovery requests', any request to produce a legal or law-related document."
---

# Legal Document Writer

Draft publication-quality legal documents in DOCX (Word) format with a **test-driven workflow**: every section is verified before moving to the next. Covers contracts, memos, briefs, complaints, demand letters, and more.

## Bundled Resources

Find the skill directory via `glob("**/legal-writer/")`.

| Resource | Path | Purpose |
|----------|------|---------|
| **Verifier** | `scripts/verify-legal.py` | TDD verification suite (10 checks) |
| **Case law API** | `scripts/courtlistener.py` | CourtListener search/lookup for case citations |
| **Regulation API** | `scripts/ecfr_lookup.py` | eCFR + Federal Register lookup for statutes/regs |
| **Bluebook ref** | `references/bluebook.md` | Bluebook citation format quick reference |
| **Doc type ref** | `references/document-types.md` | Section templates for every document type |

## The TDD Rule

**After writing every section of the document:**

```
1. WRITE section content
2. GENERATE: build/update the DOCX via the docx skill
3. VERIFY:   python3 verify-legal.py legal/{slug}/
4. If FAIL → FIX → go to 2
5. If PASS → move to next section
```

The document must pass verification at every step. Never batch errors.

## Pipeline Overview

```
Phase 1: SCAFFOLD  →  Create project, metadata.json, empty DOCX with structure
                       Verify: document exists and has correct sections ✓

Phase 2: RESEARCH  →  Case law, statutes, regulations (if litigation/regulatory doc)
                       Verify: citations are formatted correctly ✓

Phase 3: WRITE     →  Per-section drafting in logical order
                       Verify: verify-legal.py after EACH section ✓

Phase 4: POLISH    →  Self-reflection pass, strict verification, final DOCX
                       Verify: verify-legal.py --strict with zero warnings ✓
```

## Filesystem Architecture

```
legal/{document-slug}/
├── metadata.json           # Document type, parties, jurisdiction, etc.
├── document.docx           # The main document (generated via docx)
├── research/               # Case law, statutes, notes (optional)
│   ├── cases.json          # CourtListener search results
│   ├── regulations.json    # eCFR lookup results
│   └── notes.md            # Research notes
└── versions/               # Prior versions (optional)
```

### metadata.json

This file drives verification. Create it during scaffold:

```json
{
  "type": "contract",
  "title": "Services Agreement",
  "jurisdiction": "State of Delaware",
  "governing_law": "Delaware",
  "date": "2025-01-15",
  "parties": [
    {"name": "Acme Corporation", "short_name": "Company", "role": "client"},
    {"name": "Jane Smith Consulting LLC", "short_name": "Contractor", "role": "contractor"}
  ],
  "word_limit": null,
  "page_limit": null
}
```

For briefs/motions, include `word_limit` or `page_limit` from court rules.

## Phase 1: Scaffold

### 1a. Identify document type

Read `references/document-types.md` for the section template matching the requested document type. The major types:

| Type | Key | Use Case |
|------|-----|----------|
| Legal memorandum | `memo` | Internal analysis, predictive |
| Motion brief | `brief` | Persuasive, court filing |
| Contract/Agreement | `contract` | Transactional, bilateral obligations |
| Complaint/Petition | `complaint` | Initiating litigation |
| Demand letter | `demand` | Pre-litigation claim |
| Legal opinion | `opinion` | Formal legal opinion for transaction |
| Discovery requests | `discovery` | Interrogatories, doc requests |
| Settlement agreement | `settlement` | Resolving dispute |
| Terms of Service | `tos` | User-facing terms |
| Privacy Policy | `privacy` | Data privacy compliance |

### 1b. Create project structure

```bash
SLUG="document-slug-here"
mkdir -p "legal/$SLUG"/{research,versions}
```

### 1c. Create metadata.json

Write the JSON file with document type, parties, jurisdiction, and any constraints.

### 1d. Generate initial DOCX

Load the `docx` skill. Use `python-docx` to create the document with:
- Proper heading styles (Heading 1, 2, 3 for section structure)
- 12pt font (Times New Roman or similar serif for court filings)
- 1-inch margins (adjust per jurisdiction — see court rules)
- Double-spacing for briefs/court filings, single for contracts
- Proper page numbering
- Section headers matching the document type template from `references/document-types.md`
- Placeholder text: `[TO BE DRAFTED]` in each section

### 1e. VERIFY: First green state

```bash
python3 verify-legal.py legal/$SLUG/
```

The scaffolded document should exist and have correct structure. Placeholders are expected at this stage (they'll be flagged as warnings, not failures, unless `--strict`).

## Phase 2: Legal Research (if applicable)

For litigation documents (memos, briefs, complaints) and regulatory documents, research case law and statutes before writing.

### Case Law Search (CourtListener)

```bash
SKILL_DIR="..."  # from glob
# Search for relevant cases
python3 "$SKILL_DIR/scripts/courtlistener.py" search "search terms" --after 2015 --limit 10

# Get specific opinion details
python3 "$SKILL_DIR/scripts/courtlistener.py" opinion 12345

# Format as Bluebook citation
python3 "$SKILL_DIR/scripts/courtlistener.py" bluebook 12345
```

Save results to `research/cases.json`. Extract key holdings for use in the document.

**Note:** CourtListener requires a free API token for higher rate limits. Set `COURTLISTENER_API_TOKEN` env var. Without it, limited to 100 requests/day.

### Statute/Regulation Lookup (eCFR)

```bash
# Search regulations
python3 "$SKILL_DIR/scripts/ecfr_lookup.py" search "employment discrimination" --title 29

# Get specific CFR section
python3 "$SKILL_DIR/scripts/ecfr_lookup.py" section 16 444.1

# Search Federal Register for recent rules
python3 "$SKILL_DIR/scripts/ecfr_lookup.py" fedreg "data privacy"
```

No API key required.

### Citation Formatting

Read `references/bluebook.md` for Bluebook citation format. Key rules:
- **Cases:** *Party v. Party*, Vol Reporter Page, Pin (Court Year).
- **Statutes:** Title U.S.C. § Section (Year).
- **Regulations:** Title C.F.R. § Section (Year).
- **Pinpoint cites required** — always cite to the specific page.
- **Short forms** after first full citation: *Id.*, *supra*, or party name + reporter.

For non-litigation documents (contracts, ToS), formal citations are generally not needed — just reference applicable law by name and section.

## Phase 3: Per-Section Writing

### Writing Order by Document Type

**Contract:** Definitions → Core obligations → Reps & warranties → Indemnification → Limitation of liability → Term/termination → General provisions → Preamble/recitals (last, once scope is clear)

**Memo:** Question Presented → Brief Answer → Statement of Facts → Discussion (IRAC per issue) → Conclusion

**Brief:** Statement of Facts → Argument (strongest points first) → Introduction/Summary (last, once you know what to say) → Conclusion

**Complaint:** Parties → Jurisdiction/Venue → Statement of Facts → Causes of Action → Prayer for Relief

### The Writing Loop (for each section)

```
1. READ all previously written sections for context
2. WRITE the section following document-type conventions
3. REGENERATE the DOCX (update via python-docx)
4. VERIFY: python3 verify-legal.py legal/{slug}/
5. If errors → FIX → go to 3
6. SELF-REFLECT:
   - Is every legal assertion supported by authority? (litigation docs)
   - Are defined terms used consistently?
   - Any ambiguous language? ("reasonable" without standard, "timely" without deadline)
   - Cross-references point to correct sections?
   - No placeholder text remaining in this section?
7. REVISE if needed → regenerate → verify
8. Section DONE → next
```

### Legal Writing Standards

Apply these throughout all sections:

**Clarity over formality:**
- "before" not "prior to"
- "about" not "with respect to"
- "if" not "in the event that"
- "under" not "pursuant to"
- "to" not "in order to"

**Precision:**
- "shall" = duty/obligation (the party SHALL do X)
- "will" = future event or declaration
- "may" = permission (the party MAY do X)
- "must" = condition/requirement
- Never use "shall" for anything other than imposing a duty

**Defined terms:**
- Define on first use: `"Effective Date" means [definition].`
- Capitalize consistently throughout: always "Effective Date", never "effective date"
- Alphabetize in definitions section
- Don't over-define (common English words don't need definitions)

**Sentence structure:**
- Active voice: "The Contractor shall deliver" not "Delivery shall be made"
- Front-load: put the actor and action first
- One idea per sentence in contracts (each obligation = one sentence)
- Short paragraphs (max 4-5 sentences in persuasive writing)

**Numbers and dates:**
- Spell out numbers 1-9, use digits for 10+
- Dates: "January 15, 2025" (consistent throughout)
- Money: "$50,000" or "Fifty Thousand Dollars ($50,000)" (for contracts, both)
- Time periods: "thirty (30) days" in contracts; "30 days" in memos/briefs

### Section-Specific Guidance

#### Contracts: Definitions Section
```
"Agreement" means this Services Agreement, including all exhibits and schedules.

"Confidential Information" means any information disclosed by one party to the
other that is designated as confidential or that reasonably should be understood
to be confidential given the nature of the information and the circumstances of
disclosure.

"Deliverables" means the work product to be delivered by Contractor as described
in Exhibit A.
```

#### Contracts: Limitation of Liability
```
IN NO EVENT SHALL EITHER PARTY BE LIABLE TO THE OTHER PARTY FOR ANY
INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES,
REGARDLESS OF THE CAUSE OF ACTION OR THE THEORY OF LIABILITY, EVEN IF
SUCH PARTY HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

THE TOTAL AGGREGATE LIABILITY OF [PARTY] UNDER THIS AGREEMENT SHALL NOT
EXCEED THE TOTAL FEES PAID BY [OTHER PARTY] DURING THE TWELVE (12) MONTH
PERIOD PRECEDING THE CLAIM.
```

#### Memos: IRAC Discussion Structure
For each legal issue:
```
[ISSUE] The issue is whether [legal question under specific law/standard].

[RULE] Under [jurisdiction] law, [state the rule]. See [Authority]. The [court]
has held that [rule elaboration]. [Authority]. Courts consider [factors/elements]:
(1) [factor]; (2) [factor]; and (3) [factor]. [Authority].

[APPLICATION] Here, [apply each factor to the client's facts]. First, [fact]
satisfies [factor] because [reasoning]. See [analogous case]. Unlike in
[distinguishable case], where [different facts led to different outcome], here
[explain why our facts are more like the favorable case].

[CONCLUSION] Therefore, [conclusion on this issue]. A court would likely
[prediction].
```

#### Briefs: Argument Headings
Headings should be complete persuasive sentences:
```
Good:  "I. THE TRIAL COURT ERRED BY GRANTING SUMMARY JUDGMENT BECAUSE
            GENUINE DISPUTES OF MATERIAL FACT EXIST."
Bad:   "I. SUMMARY JUDGMENT"

Good:  "A. Plaintiff's Deposition Testimony Creates a Triable Issue of Fact
            Regarding Defendant's Knowledge of the Defect."
Bad:   "A. Deposition Testimony"
```

#### Complaints: Numbered Paragraphs
Every factual allegation gets its own numbered paragraph:
```
12. On or about March 15, 2024, Plaintiff entered into a written agreement
    with Defendant for the purchase of the Property (the "Purchase Agreement").
    A true and correct copy of the Purchase Agreement is attached hereto as
    Exhibit A and incorporated by reference.

13. Pursuant to Section 4.1 of the Purchase Agreement, Defendant represented
    and warranted that the Property was free of all environmental contamination.

14. On or about June 1, 2024, Plaintiff discovered that the Property contained
    significant levels of lead contamination in the soil.
```

## Phase 4: Polish & Final Verification

### 4a. Self-Reflection Pass

Re-read the entire document and check:

1. **Consistency:** Same terminology, same party names, same defined terms throughout
2. **Completeness:** All required sections present for document type, no gaps in logic
3. **Cross-references:** Every "Section X.Y" reference is correct after any reordering
4. **Defined terms:** Every capitalized term is defined, every definition is used
5. **Ambiguity:** No vague terms without standards, no dangling pronouns
6. **Placeholders:** Zero `[INSERT]`, `[TBD]`, `[TODO]`, or blank lines remaining
7. **Dates and numbers:** Consistent format throughout
8. **Citations:** (for litigation docs) All citations in Bluebook format with pinpoints

### 4b. Strict Verification

```bash
python3 "$SKILL_DIR/scripts/verify-legal.py" "legal/$SLUG/" --strict
```

All checks must pass:

- [ ] Document exists and is non-trivial size
- [ ] Defined terms: all defined, all used, consistent capitalization
- [ ] Cross-references: section/exhibit/schedule references valid
- [ ] Citations: proper format (litigation docs only)
- [ ] Zero placeholders / TODOs / draft artifacts
- [ ] Party names used consistently
- [ ] Required boilerplate provisions present (contracts)
- [ ] Modal verb consistency (shall/must/may/will)
- [ ] Word count within limits (briefs)
- [ ] Date format consistency

### 4c. Final Output

The deliverable is `legal/{slug}/document.docx`. If the user needs PDF, convert:

```bash
# If libreoffice is available:
libreoffice --headless --convert-to pdf "legal/$SLUG/document.docx" --outdir "legal/$SLUG/"

# Or use python-docx2pdf:
pip install docx2pdf && python3 -c "from docx2pdf import convert; convert('legal/$SLUG/document.docx')"
```

## DOCX Formatting Standards

When generating the DOCX (via `docx` skill / `python-docx`):

### Court Filings (briefs, motions, complaints)
- **Font:** Times New Roman, 12pt (or Century Schoolbook 12pt)
- **Spacing:** Double-spaced body text
- **Margins:** 1 inch all sides (check local rules — some require 1.5" left)
- **Page numbers:** Bottom center
- **Caption:** Court name, parties, case number — use the court's required format
- **Line numbers:** Required in some jurisdictions (e.g., California state courts)

### Contracts and Transactional Documents
- **Font:** Times New Roman or Calibri, 11-12pt
- **Spacing:** Single-spaced or 1.15
- **Margins:** 1 inch all sides
- **Section numbering:** Article → Section: 1.1, 1.2, 2.1, etc.
- **Defined terms:** Bold on first definition
- **Signature blocks:** Right-aligned or centered, with lines for signature/name/title/date
- **All-caps:** Use sparingly — limitation of liability and disclaimer sections only
- **Headers:** Document title + confidential marking if applicable
- **Footers:** Page numbers, draft date if working draft

### General
- **Heading styles:** Use Word Heading 1/2/3 styles (enables auto TOC)
- **Paragraph styles:** Use consistent named styles, not manual formatting
- **Page breaks:** Before major section headings (Articles in contracts, main sections in briefs)
- **Widow/orphan control:** Enabled (no single lines at page top/bottom)

## Jurisdiction-Specific Notes

Always check **local rules** before filing any court document. Key variations:

| Jurisdiction | Font | Spacing | Margins | Special |
|-------------|------|---------|---------|---------|
| Federal appellate | 14pt proportional serif | Double | 1" all | Word limit varies by circuit |
| U.S. Supreme Court | 12pt Century | 2pt leading | Special text field | Booklet format |
| California state | 13pt+ proportional serif | Double | 1.5" left/right | Line numbers required |
| New York state | 12pt+ proportional | Double | 1" all | Varies by court |
| Most federal district | 12pt TNR or similar | Double | 1" all | Check local rules |

When in doubt: **12pt Times New Roman, double-spaced, 1-inch margins** is safe for most courts.
