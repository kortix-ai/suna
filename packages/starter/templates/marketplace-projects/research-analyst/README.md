# Research Analyst

A ready-to-run research agent. Clone it and you get a project with one agent
— **analyst** — already wired to three research skills:

- **`deep-research`** — multi-source investigation with primary sources and
  citations, not a single web search.
- **`openalex-paper-search`** — pulls peer-reviewed academic literature when
  a question needs it.
- **`research-report`** — turns findings into a real markdown deliverable
  with inline citations, not just a chat summary.

## What you get

- `kortix.yaml` with `analyst` as the default agent.
- `.kortix/opencode/agents/analyst.md` — the agent's persona and working
  rules (investigate first, cite sources, deliver a real report, flag what's
  unknown).
- The three skills above, pulled in automatically at clone time.
- The full Kortix runtime floor (tools, plugins, memory) — same as any new
  project, so the first session works with zero extra setup.

## After cloning

Open the project and start a session. Ask a real research question and the
agent will investigate, cite sources, and write a report file rather than
just replying in chat. Edit `analyst.md` to change the persona, or add more
skills from the marketplace the same way any project would.
