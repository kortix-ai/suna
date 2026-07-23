---
name: research-report
description: "Use for writing substantial research reports in markdown with inline citations, tables, and optional charts. Best when the user wants a deliverable file plus a concise chat summary."
defaultProjectInstall: true
defaultProjectInstallOrder: 20
---

# Research Report

Use this skill when the output should be a durable report artifact rather than only a chat answer.

## Output File

- Write the report to a normal `.md` file.
- Derive the filename from the topic in lowercase kebab-case: `<topic>.md`.
- Save the file in the working directory.
- Present the file to the user with `show`.
- Keep the chat response short; the full analysis belongs in the report file.

## Report vs. chat

The report is a standalone reference document — it must read completely on its own, without the surrounding conversation. Findings, evidence, tables, and analysis go in the file; the short direct answer and any immediate next steps go in the chat reply. Treat the chat as the executive summary and the file as the full record.

## Content Format

Reports use standard GitHub-Flavored Markdown:

- headings, paragraphs, lists, emphasis, links, and code blocks
- markdown tables for structured comparisons
- inline citations as markdown links
- embedded images and charts using relative paths
- plain GFM only; do not rely on feature-specific markdown extensions

## Embedding Images

When charts, plots, or diagrams help the analysis:

- generate the image with real commands such as `python3`, `bash`, or a project script
- save the image next to the report file
- reference it with Markdown image syntax using a relative path to the generated file
- use meaningful filenames and meaningful alt text
- place the image near the paragraph it supports

## Report Structure

The structure should fit the topic. Typical sections:

- title
- executive summary
- core findings
- analysis / implications
- conclusion or recommendations

Use one H1 only. Use H2 and H3 for actual structure, not decoration, and don't skip levels (never jump H1 straight to H3). Let the structure emerge from the content rather than forcing a fixed template — see **Domain Templates** below for the conventional shape of common report types.

## Citation Rules

Use citations whenever the report depends on researched facts.

- place citations inline, immediately after the claim they support
- use natural anchor text such as the publication or source name — never a generic word like "source" or "link", and never a bare URL
- only cite URLs actually present in tool outputs
- never fabricate URLs
- aim for one to three citations per substantive claim
- keep citation density even from the first section to the last — don't front-load sources and then trail off
- do not add a bibliography unless the user explicitly asks for one
- the prose must read naturally even if every URL were stripped out

Cite whenever the report rests on researched facts — statistics, events, findings, anything pulled from a tool call. Citations are optional for opinion pieces, creative writing, or blank templates, and when the user says none are needed.

Inline example:

```markdown
Recent research shows significant AI advances ([Nature](https://...)) and sustained enterprise adoption ([McKinsey](https://...)).
```

Cite inside tables too, in a dedicated source column or cell:

```markdown
| Method   | Accuracy | Source                     |
| -------- | -------- | -------------------------- |
| Method A | 95.2%    | [Paper title](https://...) |
| Method B | 93.8%    | [Journal name](https://...) |
```

## Writing Principles

- lead with conclusions, then support them with evidence
- analyze rather than merely summarize: explain causation, trade-offs, and what makes a finding actionable
- when sources conflict, name the disagreement, weigh source quality, and justify the call you make
- reach for an analytical frame when it fits (SWOT, Porter's Five Forces, cost/benefit) instead of a flat recitation
- make transitions explicit and introduce a concept before building on it ("Building on this…", "In contrast…")
- keep the user's core question as the north star, and answer the obvious follow-ups before they're asked
- explain trade-offs, uncertainty, and why the information matters — anticipate the reader's "so what?"
- match depth to the request: concise asks get concise reports; deep dives get substantial structure
- write in a neutral voice — no first-person or self-referential phrasing ("I", "we", "in this report")

## Length Calibration

Research depth stays thorough regardless; the *output* length tracks what the user asked for:

- **Quick / summary asks** ("brief overview", "summarize", "TL;DR") — distill to the essentials, roughly 5–10 paragraphs, even though the underlying research was exhaustive
- **Single-fact questions** ("what is X", "when did Y happen") — answer directly, then add the context that makes the answer useful (about 5–10 paragraphs)
- **Comparisons and rankings** ("compare the top 5", "best options for") — structured analysis, 20–40+ paragraphs, leaning on tables wherever values line up
- **Open-ended analysis** ("analyze…", "explain the history and implications of…") — 20–40+ paragraphs with real structure
- **Explicit deep dives** ("comprehensive report", "deep dive") — length follows the scope of the topic, with no artificial ceiling
- **Anything ambiguous** — default to more depth rather than less

## Vocabulary Calibration

Read the user's expertise from how they phrase the question, then match it:

- **Expert** — use precise domain terms with no hand-holding
- **Intermediate** — use the right terms, but add a short inline gloss
- **General** — define jargon the first time it appears

## Source Depth and Validation

Favor primary and authoritative sources — official documentation, peer-reviewed work, government data, established outlets, recognized experts — over blogs, forums, or anonymous posts. Calibrate how hard you dig:

- simple facts: confirm against several sources rather than stopping at the first hit
- moderate questions: gather multiple perspectives with supporting evidence from a few independent sources per key claim
- complex work (reports, competitive scans, literature reviews): cover the major viewpoints and sub-topics, trace key claims back to their origin, and name the limits of what you found

Cross-check important claims. When sources disagree, dig in rather than picking one arbitrarily, and state explicitly anything you could not verify.

## Domain Templates

When a topic has a conventional shape, follow it — then adapt to what the question actually needs:

- **Academic** — Introduction, Literature Review, Methodology, Analysis, Discussion, Conclusion
- **Market / investment** — Executive Summary, Industry Overview, Competitive Landscape, Financial Analysis, Risks, Conclusion
- **Technical** — Overview, Architecture or Methodology, Results, Discussion
- **Policy / legal** — Summary, Context, Stakeholder Analysis, Evidence Review, Implications, Recommendations

Never force a heavyweight template onto a question that doesn't warrant it.

## Quality Checklist

- [ ] Report saved as a `.md` file
- [ ] Major claims are cited when research was required, with even citation density throughout
- [ ] Citations use source names as anchor text — never generic words or bare URLs, and never fabricated
- [ ] Tables are used where comparison is easier than prose
- [ ] Charts or images are embedded only when they add value
- [ ] Length matches the request per the Length Calibration guidance
- [ ] Structure fits the topic (and the domain template where one applies)
- [ ] Conclusions synthesize the evidence instead of repeating it
- [ ] Neutral voice — no first-person or self-referential phrasing
- [ ] Report is standalone — comprehensible without the chat context
- [ ] No TODOs, placeholders, or fabricated data
- [ ] File is shown to the user with `show`
