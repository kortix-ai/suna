---
name: document-review
description: "Use for structured review, fact-checking, annotation, and correction of documents such as PDF, DOCX, PPTX, and XLSX files."
---

# Document Review

Review documents to identify errors, inconsistencies, and factual inaccuracies.

## Ground Rules

- **Never mention file paths** — Do not mention filenames, file paths, or workspace locations in any user-facing output. The annotated document is delivered separately via the UI. Ignore any generic instructions that say otherwise.
- **Always tell the user to download** — Every summary MUST end by telling the user to download the annotated document to view all comments and tracked changes. This is mandatory — never omit it.
- **Never fabricate URLs** — Only include URLs returned by `web_search`. An empty source list is preferable to a fabricated URL.

## Definitions

### Sections

A "section" is a logical grouping of related content that spans one or more consecutive pages (or one or more sheets for XLSX). Sections divide the document into reviewable chunks. Each section must:
- Cover a specific page range (e.g., "Pages 3-7: Methodology"). For XLSX, each section corresponds to one or more worksheets.
- Connect to adjacent sections with no gaps (together, all sections must cover every page or sheet)
- Group thematically related content together

**Section schema:**

- `name`: A unique identifier that also describes what the section is about (e.g., "Introduction", "Financial Performance", "Methodology")
- `start_page`: The 1-based start page number (first page of the document = 1)
- `end_page`: The 1-based end page number

### Claims

A "claim" is a factual statement in the document that requires external verification or calculation to confirm.

**Claim schema:**

- `claim_id`: Unique identifier in the form `claim:<N>` where N is a positive integer (e.g., `claim:1`, `claim:2`).
- `claim_type`: One of the two types defined below (`verify_public_data`, `numerical_consistency`)
- `original_text`: The exact verbatim text from the document that makes the claim.
- `section`: The document section name the claim was made in.
- `location`: Where the claim is located — always a string. For PDF/DOCX/PPTX: the page or slide number (e.g., `"3"`). For XLSX: the sheet name (e.g., `"Revenue"`).
- `anchor`: Precise position within the location, or null. For PDF/DOCX/PPTX: a descriptive label (e.g., `"paragraph 5"`, `"Risk Factors heading"`, `"Table 2, row 3"`). For XLSX: a cell reference (e.g., `"B14"`). Be specific — use `"paragraph 5"` not `"5"`.
- `claim_status`: One of the four statuses defined below (`unverified`, `verified`, `refuted`, `inconclusive`)
- `source_urls`: List of URLs from `web_search` results that were used to verify or refute this claim. Empty list for `numerical_consistency` claims and when no sources were found. Never fabricate URLs — only use URLs returned by `web_search`.

### Claim Types

- `verify_public_data`: Facts that need external sources to verify. Requires web search to fact-check.
  - Statistics ("U.S. population is 340 million")
  - Historical facts ("The Paris Agreement was signed in 2016")
  - Published data ("The study had 10,000 participants")
  - Attributed claims ("According to WHO, global life expectancy is 73 years")

- `numerical_consistency`: Calculations using numbers from within the document. Requires python code to perform calculations to verify.
  - Addition/subtraction ("Region A: 500 + Region B: 300 = 800 total")
  - Percentages ("40% of 1,000 respondents = 400")
  - Ratios ("$2.4M budget / 12 months = $200K per month")
  - Growth calculations ("from 100 to 125 = 25% growth")

### Claim Statuses

- `unverified`: Initial status — the claim has not been fact-checked yet.
- `verified`: Fact-checked and determined to be correct.
- `refuted`: Fact-checked and determined to be false. Refuted claims become issues.
- `inconclusive`: Fact-checked, but no conclusion can be made. Inconclusive claims become issues.

### Issues

An "issue" is a specific problem found in the document. Issues are the primary output of the review — every issue becomes a comment/annotation in the final document.

**Issue schema:**

- `issue_type`: One of the five types defined below (`spelling_grammar`, `narrative_logic`, `non_public_info`, `verify_public_data`, `numerical_consistency`)
- `severity`: `high`, `medium`, or `low` (see Severity Levels below)
- `original_text`: The exact verbatim text from the document that contains the issue. This is the text you would highlight to show a reader where the problem is.
- `description`: A concise explanation of why `original_text` is wrong or problematic. Write as 1-2 direct sentences that a reviewer can scan without re-reading. Lead with what's wrong, then state what's correct or expected. Avoid filler ("It appears that...", "There seems to be...") — state the problem directly. Examples: "Revenue is stated as $28T but publicly reported figures show $25.5T for 2023." / "The word 'acheived' is misspelled." / "Page 3 says 'founded in 2015' but page 7 says 'celebrating 10 years' in 2023, which implies 2013."
- `text_context`: A longer passage containing `original_text` with surrounding text before and after. Used to disambiguate when `original_text` appears multiple times in the document.
- `new_text`: The suggested replacement for `original_text`. Should closely resemble the original but with the issue fixed.
- `section`: The document section name the issue is in.
- `location`: Where the issue is located — always a string. For PDF/DOCX/PPTX: the page or slide number (e.g., `"3"`). For XLSX: the sheet name (e.g., `"Revenue"`).
- `anchor`: Precise position within the location, or null. For PDF/DOCX/PPTX: a descriptive label (e.g., `"paragraph 5"`, `"Risk Factors heading"`, `"Table 2, row 3"`). For XLSX: a cell reference (e.g., `"B14"`). Be specific — use `"paragraph 5"` not `"5"`.
- `issue_id`: Unique identifier in the form `issue:<N>` where N is a positive integer (e.g., `issue:1`, `issue:2`).
- `root_issue_id`: The `issue_id` of an earlier issue that caused this one. Use when an error cascades — e.g., page 1 says "U.S. population is 200 million" (wrong, `issue:1`), then page 2 says "10% of the U.S. population is 20 million" — the math is correct for the stated figure but based on the wrong number from `issue:1`, so `issue:2` sets `root_issue_id` to `issue:1`. Omit when the issue is independent.

### Issue Types

- `spelling_grammar`: Misspelled words and grammatical errors.
  - IS: "acheived" → "achieved" (misspelling)
  - IS: "A total of $100 millions dollars" (grammar: "millions" → "million")
  - IS: "the the report" (repeated word)
  - IS: "Their going to expand" ("Their" → "They're")
  - NOT: Wrong dates, wrong numbers, backwards timelines (→ `narrative_logic`)
  - NOT: Redundant or nonsensical titles/headings (→ `narrative_logic`)
  - NOT: Real names used instead of code names (→ `non_public_info`)
  - **Test**: Could a spell-checker or grammar-checker catch this? If yes → `spelling_grammar`. If it requires understanding meaning or context → it's another type.

- `narrative_logic`: Logical errors, contradictions, timeline problems, nonsensical content, or structural issues that require understanding meaning to detect.
  - IS: "Founded in 2015" on page 3 but "celebrating 10 years" in 2023 (contradiction)
  - IS: "Expected to grow from 500 in 2025 to 600 in 2020" (backwards timeline)
  - IS: "Comparable Comps Analysis" (tautological — "Comparable" and "Comps" mean the same thing)
  - IS: "Fitness Industry Page" as a section title ("Page" is redundant — the audience already knows it's a page)
  - IS: Document dated January but references "Q4 results" as if complete (impossible timeline)
  - IS: A section header that contradicts the document's own conventions or makes no sense
  - NOT: Misspelled words (→ `spelling_grammar`)
  - NOT: Confidential information leaks (→ `non_public_info`)
  - **Test**: Does this require understanding what the words mean (dates, logic, context) to spot the error? If yes → `narrative_logic`.

- `non_public_info`: Confidential information that should not appear in the document.
  - IS: Using real company names instead of code names (e.g., "Planet Fitness" when code name is "Pluto")
  - IS: Individual salaries, SSNs, private email addresses, phone numbers
  - IS: Unreleased product details, internal strategies, board deliberations
  - IS: "STRICTLY CONFIDENTIAL" or "INTERNAL USE ONLY" markers left in a public-facing document
  - NOT: Misspelled names (→ `spelling_grammar`)
  - NOT: Contradictions about confidential info (→ `narrative_logic`)
  - **Test**: Is the problem that confidential or private information is exposed? If yes → `non_public_info`.

- `verify_public_data`: Facts that differ from verifiable external sources. Requires web search to verify.
  - IS: "U.S. GDP was $28T" but actual is $25T (refuted → create issue)
  - IS: "The treaty was signed in 2018" (actually 2016) (refuted → create issue)
  - IS: "2024 Q4 results were $45M" but no public data available yet (inconclusive → create issue)
  - NOT: Dates that contradict other dates within the document (→ `narrative_logic`)

- `numerical_consistency`: Math errors using the document's own numbers. Requires calculation to verify.
  - IS: "Region A: 500 + Region B: 300 = 900" (should be 800) (refuted → create issue)
  - IS: "40% of 1,000 = 500" (should be 400) (refuted → create issue)
  - IS: "$2.4M budget / 12 months = $150K/month" (should be $200K/month) (refuted → create issue)
  - NOT: A timeline going backwards (→ `narrative_logic`)

### Severity Levels

- `high`: Consequences beyond the document — could lead to wrong decisions, legal exposure, or real-world harm (e.g., materially wrong financials, leaked PII, verifiably false facts with regulatory implications)
- `medium`: Undermines the document's credibility — a reader who notices would question whether the rest of the document can be trusted (e.g., internal contradictions, calculation errors, timeline inconsistencies)
- `low`: Undermines professionalism only — looks sloppy but doesn't mislead or cause harm (e.g., typos, grammar errors, repeated words)

## Background Session Setup

Document review is a long, meticulous process — always run it in a background session using the Kortix sessions flow.

Before spawning, determine which **issue types** are relevant from the user's request. When in doubt, default to all 5 types. Examples:
- "review this", "audit this" → all 5 types
- "spell-check this", "proofread this", "check for typos" → `spelling_grammar`
- "fact-check this", "verify the numbers" → `verify_public_data`, `numerical_consistency`
- "check for confidential info" → `non_public_info`

```text
session_start_background(
  project="<project-name-if-applicable>",
  prompt="Load the document-review skill and execute its workflow to review the attached document. Issue types: [list the relevant issue types]."
)
```

Use `session_read` to inspect progress and the final review output. After the background session completes, present the annotated document with `show`.

When responding to the user after the review completes, do not mention internal file paths or workspace locations. The annotated document should be delivered separately via the UI.

## Document Type and Specializations

Before starting the workflow, read the document and determine its type (e.g., "investment memo", "research paper", "marketing proposal", "legal contract"). The document type drives whether to load a specialization file with domain-specific guidance.

If the document matches a specialization below, load it for domain-specific examples, severity calibration, and search strategies. Apply the specialization's guidance throughout all remaining phases.

- **Finance/Investment** (investment memo, CIM, pitch deck, offering memorandum, financial model, quarterly/annual report, prospectus): `read("skills/GENERAL-KNOWLEDGE-WORKER/document-review/specializations/finance.md")`

For documents that don't match any specialization, do not load a specialization file. Proceed with the general examples and guidance in this file.

## Workflow

The review workflow is a 6-phase pipeline that transforms a raw document into an annotated copy with issues marked as comments. Each phase builds on the previous: sections structure the document, claims extract verifiable facts, fact-checking confirms or refutes claims, issues capture all problems found, annotation marks them in the document, and submission finalizes the review. All state is managed through `manage_state.py` script commands that read and write `document_review_state.json`.

Execute phases strictly in order — do not reorder. Skip phases only when their conditions below allow it:

1. **Create sections** — Analyze document structure and divide into thematic sections
   - End: All sections created with page ranges
2. **Create claims** — Identify fact-checkable statements and create claim records
   - Skip if only `spelling_grammar`, `narrative_logic`, and/or `non_public_info` requested
   - End: Claims created from every section
3. **Update claims** — Fact-check claims and update their status
   - Skip if Phase 2 was skipped or no claims were created
   - End: All claims updated (verified/refuted/inconclusive)
4. **Create issues** — Review sections for problems and create issue records
   - Only create issues for the requested types
   - End: Every section reviewed, issues created (including for refuted/inconclusive claims)
5. **Annotate document** — Create annotated copy with issues marked as comments/annotations
   - End: Annotated document saved to workspace
6. **Submit review** — Compile and submit final review
   - End: Review submitted

**FORBIDDEN**: `web_search`, `bash`, `list_external_tools`, and `call_external_tool` are only for Phase 3 (fact-checking claims). Do not use them in any other phase.


## Processing Strategy

All review state lives in `document_review_state.json` — a single JSON file in the working directory that tracks the current phase, sections, claims, issues, and summary. Every phase reads and writes this file through `manage_state.py` (at `skills/GENERAL-KNOWLEDGE-WORKER/document-review/scripts/manage_state.py`). All `manage_state.py` commands and annotation scripts are executed as bash tool calls. The state file must be initialized with `manage_state.py init` before any other commands. Use `manage_state.py status` at any point after initialization to check progress.

Commands that take `--data` also accept `--file` as an alternative — the file must contain the same JSON array that would be passed inline to `--data`. Use `--file` when the JSON payload is large:
- `manage_state.py add-issues "Section Name" --file issues.json`

### Phase 1 (Create sections)

Read the entire document and divide it into thematic sections. Sections define the units of work for all later phases — claims are extracted per section, issues are created per section, so getting the boundaries right here determines the quality of everything downstream.

- `manage_state.py add-sections --data '[{"name": "Introduction", "start_page": 1, "end_page": 5}, ...]'`

Read the document end-to-end before creating sections. Look for natural thematic boundaries: topic shifts, headings, or transitions between distinct subject areas. Name each section descriptively (e.g., "Market Analysis", "Risk Factors", not "Section 3" or "Pages 5-8"). For XLSX, each section typically corresponds to one worksheet — use the sheet name as the section name. Call add-sections once with all sections — together they must cover every page or sheet with no gaps or overlaps.

Section limits:
- 1–4 pages (or sheets): max 2 sections
- 5–8 pages (or sheets): max 4 sections
- 9+ pages (or sheets): max 8 sections

### Phase 2 (Create claims)

Scan every section for statements that need external verification or calculation, and create a claim record for each one. Claims feed Phase 3's fact-checking pipeline — they exist only for facts that cannot be confirmed by reading the document alone.

- `manage_state.py add-claims "Section Name" --data '[{"claim_type": "verify_public_data", "description": "Population was 340 million", "original_text": "Population was 340 million", "location": "5", "anchor": "paragraph 3"}, ...]'`

**Create a claim when** the statement requires:
- **Web search** (`verify_public_data`) — statistics, dates, published data, or attributed facts that must be checked against external sources
- **Calculation** (`numerical_consistency`) — arithmetic using numbers from the document (sums, percentages, ratios, growth rates) that must be computed to verify

**Do NOT create a claim when** the problem is detectable by reading the document:
- Timeline impossibilities, internal contradictions, or logical errors (catch as `narrative_logic` issues in Phase 4)
- Spelling errors, typos, grammar mistakes, formatting problems (catch as `spelling_grammar` issues in Phase 4)
- Statements that don't need verification (headers, generic text, opinions)

Process every section. One add-claims call per section. These calls are independent — run up to 4 in parallel.

### Phase 3 (Update claims)

Fact-check each claim using the `web_search` and `bash` tools, then record results by updating claim statuses through `manage_state.py update-claims`. Use `manage_state.py get-claims --status unverified` to check which claims still need fact-checking.

**web_search tool** — Fact-check `verify_public_data` claims against external sources. Takes a `queries` array (max 3 per call): the first query is the primary search, the remaining are reformulations to broaden coverage. Use short, keyword-focused queries — longer queries reduce result quality.
- Start broad — a single search can verify multiple related claims (e.g., searching for a company's annual report may confirm revenue, headcount, and founding date at once). Narrow queries to target specific claims only after broad searches leave gaps.
- **Year selection**: Always include the year in queries (e.g., "U.S. GDP 2023" not just "U.S. GDP"). Check the document date first (headers, footers, "as of" statements) and search for data from the year the document references. If unclear, use the most recent complete year before today's date. Don't mix years.
- Use `allowed_domains` to target authoritative sources when relevant (e.g., `["sec.gov", "investor.apple.com"]`)
- Break multi-entity questions into separate single-entity queries
- Be pragmatic: if a claim cannot be verified after 2-3 search attempts with different query formulations, mark it as inconclusive and move on. Do not spend unlimited turns chasing a single claim.


**bash tool** — Verify `numerical_consistency` claims with Python calculations. Takes a `command` string — use `python -c` one-liners with exact values from the document. **NEVER do mental math** — always use bash with Python for numerical verification.
- Examples:
  - `python -c "print(500 + 300)"` → verify "500 + 300 = 800"
  - `python -c "print(0.40 * 1000)"` → verify "40% of 1,000 = 400"
  - `python -c "print(2.4 / 12)"` → verify "$2.4M / 12 months = $200K"
  - `python -c "print((125 - 100) / 100 * 100)"` → verify "25% growth from 100 to 125"

**Parallelism** — Fact-checking is the most time-consuming phase. `web_search` and `bash` (Python calculations) are independent and can run in parallel (up to 4 per turn).

**update-claims** — After each round of tool calls, record results for all claims checked in that round:
- `manage_state.py update-claims --data '[{"claim_id": "claim:1", "claim_status": "verified", "source_urls": ["https://example.com/report"]}, ...]'`
- **Verified** — Confirmed accurate. Exact values must match exactly; approximations (~, approximately, about) allow 5% variance.
- **Refuted** — Contradicted by search results or calculations. If you find clear data that contradicts the claim, mark as refuted, not inconclusive.
- **Inconclusive** — Cannot be verified. Mark as inconclusive only when no reliable data exists after multiple search attempts, results genuinely conflict, or data is not yet available (e.g., future periods).
- **source_urls** — Include URLs from `web_search` results that informed the verdict. For `numerical_consistency` claims (verified via calculation), pass an empty list. Never fabricate URLs.

```
Turn 4: web_search("Acme Corp 2023 annual report") + web_search("U.S. census 2023") + bash(calc claim:5) + bash(calc claim:6)
         → broad searches verify claims 1-3 (revenue, headcount, founding date) + claim 4 (population) + claims 5-6 (math)
Turn 5: update-claims [1-6] + web_search("Acme Corp acquisition history") + bash(calc claim:9)
         → narrow search for claims 7-8 that broad searches missed
Turn 6: update-claims [7-9] + web_search("specific fact still unverified")
```

### Phase 4 (Create issues)

Re-read each section and identify every problem — spelling errors, logical contradictions, confidential information leaks, and any issues from refuted or inconclusive claims. This is a fresh pass through the document, not just a conversion of claims to issues. Only create issues for the requested types (see Subagent Setup).

- `manage_state.py add-issues "Section Name" --data '[{"issue_type": "spelling_grammar", "severity": "low", "description": "Typo found", "location": "3", "anchor": "paragraph 2", "original_text": "acheived", "text_context": "The organization acheived its goals", "new_text": "achieved", "root_issue_id": null}, ...]'`

One section per call, sequential in document order. Categorize each issue by its actual nature (see Issue Types in Definitions) — never force an issue into a type just because the user's request mentioned that type.

- **MANDATORY**: Create issues for ALL refuted and inconclusive claims (100% conversion rate). Use `manage_state.py get-claims --status refuted` and `--status inconclusive` to ensure none are missed. Preserve the claim's type (`verify_public_data` → `verify_public_data` issue, `numerical_consistency` → `numerical_consistency` issue). For inconclusive claims, explain why verification failed (e.g., "Data not publicly available", "Conflicting sources found").
- Use `manage_state.py get-issues` to review previously created issues when setting `root_issue_id` — link cascading errors back to the root issue that caused them.
- Never reference claim IDs in issue descriptions — claims are internal tracking; issues become user-facing comments.

### Phase 5 (Annotate document)

Create an annotated copy of the document with issues as comments. `{base_name}` is the original filename without its extension.

- **PDF/PPTX/XLSX** — Single command; the script reads issues from `document_review_state.json` automatically:
  - `python skills/document-review/scripts/annotate_pdf.py input.pdf {base_name}_reviewed.pdf`
  - `python skills/document-review/scripts/annotate_pptx.py input.pptx {base_name}_reviewed.pptx`
  - `python skills/document-review/scripts/annotate_xlsx.py input.xlsx {base_name}_reviewed.xlsx`
- **DOCX** — `read `skills/GENERAL-KNOWLEDGE-WORKER/docx/SKILL.md`` and follow its workflow to unpack, edit XML, and repack. Use `manage_state.py get-issues` to list all issues, then for each issue:
  1. **Add a comment** using `comment.py --author "Kortix"`, then insert `<w:commentRangeStart>`, `<w:commentRangeEnd>`, and `<w:commentReference>` markers in `document.xml`. Place `<w:commentRangeStart>` immediately before the first `<w:r>` that contains the `original_text`, and `<w:commentRangeEnd>` immediately after the last `<w:r>` that contains it — do NOT place these at the paragraph or body level.

     **Comment text format** — every comment MUST use this exact single-line format. Do NOT use `\n` or line breaks — `comment.py` renders them as literal text, not actual breaks. No "Suggested" line — the tracked change shows the fix.

     ```
     [Type Label | severity] description
     ```

     Type label mapping: `spelling_grammar` → `Spelling/Grammar`, `narrative_logic` → `Narrative/Logic`, `non_public_info` → `Non-Public Info`, `verify_public_data` → `Public Data`, `numerical_consistency` → `Numerical Consistency`.

     Example `comment.py` call for a spelling issue:
     ```bash
     python skills/GENERAL-KNOWLEDGE-WORKER/docx/scripts/comment.py unpacked/ 0 "[Spelling/Grammar | low] The word 'acheived' is misspelled." --author "Kortix"
     ```

     Example for a numerical consistency issue:
     ```bash
     python skills/GENERAL-KNOWLEDGE-WORKER/docx/scripts/comment.py unpacked/ 1 "[Numerical Consistency | high] Region totals sum to 800, not the stated 900." --author "Kortix"
     ```
  2. **Apply tracked changes** (best effort) when `new_text` differs from `original_text`: find the exact `<w:r>` in `document.xml` whose `<w:t>` contains `original_text` and replace that `<w:r>` with a `<w:del>` + `<w:ins>` pair. Copy the `<w:rPr>` from that specific `<w:r>` into both the `<w:del>` and `<w:ins>` runs — do NOT use `<w:rPr>` from any other run (e.g., the title or a different paragraph). Wrap the comment markers tightly around the `<w:del>` and `<w:ins>` so the comment is anchored to the change.

  Before writing tracked changes, capture the current timestamp in the user's local timezone (from the User Timezone field in the context block):
  `TZ="{user_timezone}" date +"%Y-%m-%dT%H:%M:%SZ"`
  Use this value for all `w:date` attributes in `<w:del>` and `<w:ins>` elements.

  The combined pattern for a comment with a tracked change:
  ```xml
  <w:commentRangeStart w:id="0"/>
  <w:del w:id="1" w:author="Kortix" w:date="{timestamp}">
    <w:r><w:rPr><!-- original formatting --></w:rPr><w:delText>original text</w:delText></w:r>
  </w:del>
  <w:ins w:id="2" w:author="Kortix" w:date="{timestamp}">
    <w:r><w:rPr><!-- original formatting --></w:rPr><w:t>new text</w:t></w:r>
  </w:ins>
  <w:commentRangeEnd w:id="0"/>
  <w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>
  ```

  If the `original_text` cannot be located in the XML (e.g., it spans multiple runs or paragraphs in a way that makes surgical replacement impractical), still add the comment anchored to the nearest matching text — a comment without a tracked change is better than no annotation at all.

  Save the result as `{base_name}_reviewed.docx`.

### Phase 6 (Submit review)

- `manage_state.py submit "summary text"`
- Call once after annotation is complete. The summary is the background review session's final output — it becomes the response the user sees.
- Use `manage_state.py get-issues` and `get-claims` to gather data for the summary.

**Summary format:**

1. Opening line — confirm review completion, coverage, and total issue count
2. Claims summary (skip if no claims were created):
   - Total claims checked, broken down by status (e.g., "Verified 42 of 49 claims — 5 refuted, 2 inconclusive")
3. Issues tables — one table per severity level, each with a heading (e.g., **High-Severity Issues**):

**High-Severity Issues**

| Location | Type | Issue | Finding |
|----------|------|-------|---------|
| p. 3 | Public Data | Revenue stated as $28T | Publicly reported figure is $25.5T for 2023 |
| p. 7 | Numerical | Region totals sum to 900 | Correct sum is 800 (500 + 300) |

**Medium-Severity Issues**

| Location | Type | Issue | Finding |
|----------|------|-------|---------|
| p. 3 | Narrative/Logic | Backwards projection year | "to $55-60B by 2020" — 2020 is in the past |

**Low-Severity Issues**

| Location | Type | Issue | Finding |
|----------|------|-------|---------|
| p. 5 | Spelling/Grammar | "Comparable Comps" | Tautological — "Comps" already means "Comparables" |

4. Closing line — **MUST** end with a sentence telling the user to download the annotated document to view all comments and tracked changes.

**Tone**: Professional, constructive, and solution-focused. Frame issues as opportunities for improvement rather than failures.

## Example Workflow

For a document with 8 sections and 49 claims:

```
Setup:
  manage_state.py init "Report.pdf"
  (if applicable) read specialization file for domain-specific guidance

Phase 1: Create sections
  Step 1: manage_state.py add-sections --data '[...]' → 8 sections

Phase 2: Create claims
  Step 2: add-claims "Section 1" + add-claims "Section 2" + add-claims "Section 3" + add-claims "Section 4" (4 parallel)
  Step 3: add-claims "Section 5" + add-claims "Section 6" + add-claims "Section 7" + add-claims "Section 8" (4 parallel)
  → 49 claims created

Phase 3: Update claims
  Step 4: get-claims --status unverified + web_search for facts + bash for calculations (parallel)
  Step 5: update-claims [1-15] + web_search(claims 16-30) (parallel)
  Step 6: update-claims [16-30] + bash(calculations 31-45) (parallel)
  Step 7: update-claims [31-45] + final searches (parallel)
  Step 8: update-claims [46-49]
  → All 49 claims updated

Phase 4: Create issues
  Steps 9-16: manage_state.py add-issues "Section N" --data '[...]' (sequential, one per step)
  → Issues created for all problems

Phase 5: Annotate document
  Step 17: python skills/document-review/scripts/annotate_pdf.py Report.pdf Report_reviewed.pdf
  → Annotated document saved to workspace

Phase 6: Submit review
  Step 18: manage_state.py submit "Review summary"
```

## Output

The only output file is the annotated document (`{base_name}_reviewed{suffix}`). Do NOT create separate report files (markdown, text, etc.).
