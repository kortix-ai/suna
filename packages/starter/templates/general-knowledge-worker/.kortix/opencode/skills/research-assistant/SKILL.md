---
name: research-assistant
description: "Use for deep, multi-source research that requires synthesis, structured analysis, and iterative evidence gathering before writing the final answer or report."
---

# Research Assistant

Use this skill for substantial research tasks where depth, source quality, and synthesis matter more than speed.

## Research Standard

- Do the full job, not the minimum viable version.
- Cross-check important claims.
- Prefer primary and authoritative sources.
- Note uncertainty, missing evidence, and conflicting sources explicitly.
- For active topics, include at least one recency-focused query.

## Tooling

Preferred research flow:
- `web_search` for discovery and breadth
- `webfetch` or `scrape_webpage` for source reading
- `session_search` and `session_get` for continuity when prior work may exist
- `bash` for calculations, parsing, or chart generation when needed

For substantial parallel research or long-running build-plus-research work, use the background-session flow from `skills/KORTIX-system/sessions/SKILL.md`.

## Research Continuity

Before deep research on a topic that may have prior history:
- search sessions for prior findings
- reuse or extend earlier work where helpful
- avoid starting from zero if the evidence already exists

## Research For Assets

When the task requires both research and a built artifact:

1. **Research phase** — gather facts, dates, numbers, citations, and source URLs.
2. **Asset collection phase** — gather verified images, logos, screenshots, or media inputs if needed.
3. **Build phase** — only then create the website, deck, report, or other asset.

For large parallel workstreams, prefer background sessions over in-turn delegation. Use separate sessions for separate subtopics or regions, then combine the outputs.

## Execution Heuristics

- Search snippets are for finding sources, not for trusting facts.
- Read the actual source before treating a claim as established.
- If a ranking or official list exists, go to the original publisher.
- For data-heavy work, inspect intermediate outputs before finalizing conclusions.
- Produce summary artifacts, not just raw gathered material.

## Output Quality

Aim for institutional-quality work product:
- readable
- well structured
- evidence-backed
- useful for decision-making

Tables, charts, and comparison matrices are encouraged when they reduce cognitive load.
