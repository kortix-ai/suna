---
name: research-report
description: "Use for writing substantial research reports in markdown with inline citations, tables, and optional charts. Best when the user wants a deliverable file plus a concise chat summary."
---

# Research Report

Use this skill when the output should be a durable report artifact rather than only a chat answer.

## Output File

- Write the report to a normal `.md` file.
- Derive the filename from the topic in lowercase kebab-case: `<topic>.md`.
- Save the file in the working directory.
- Present the file to the user with `show`.
- Keep the chat response short; the full analysis belongs in the report file.

## Content Format

Reports use standard GitHub-Flavored Markdown:

- headings, paragraphs, lists, emphasis, links, and code blocks
- markdown tables for structured comparisons
- inline citations as markdown links
- embedded images and charts using relative paths
- plain GFM only; do not rely on feature-specific markdown extensions

## Embedding Images

When charts, plots, or diagrams help the analysis:

```markdown
![revenue-growth-chart](./revenue-growth-chart.png)
```

Rules:
- generate the image with real commands such as `python3`, `bash`, or a project script
- save the image next to the report file
- reference it with a relative path like `./chart.png`
- use meaningful filenames and meaningful alt text
- place the image near the paragraph it supports

## Report Structure

The structure should fit the topic. Typical sections:

- title
- executive summary
- core findings
- analysis / implications
- conclusion or recommendations

Use one H1 only. Use H2 and H3 for actual structure, not decoration.

## Citation Rules

Use citations whenever the report depends on researched facts.

- place citations inline, immediately after the claim they support
- use natural anchor text such as the publication or source name
- only cite URLs actually present in tool outputs
- never fabricate URLs
- do not add a bibliography unless the user explicitly asks for one

Example:

```markdown
Recent research shows significant AI advances ([Nature](https://...)) and sustained enterprise adoption ([McKinsey](https://...)).
```

## Writing Principles

- lead with conclusions, then support them with evidence
- analyze rather than merely summarize
- explain trade-offs, uncertainty, and why the information matters
- match depth to the request: concise asks get concise reports; deep dives get substantial structure
- calibrate vocabulary to the user's sophistication

## Quality Checklist

- [ ] Report saved as a `.md` file
- [ ] Major claims are cited when research was required
- [ ] Tables are used where comparison is easier than prose
- [ ] Charts or images are embedded only when they add value
- [ ] Conclusions synthesize the evidence instead of repeating it
- [ ] File is shown to the user with `show`
