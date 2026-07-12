# Support Agent Kit

A ready-to-run customer support agent. Clone it and you get a project with
one agent — **support** — already wired to two skills:

- **`ticket-triage`** — categorizes, prioritizes, and routes incoming tickets
  before anything gets a reply.
- **`canned-responses`** — builds consistent, on-brand replies from a
  template library instead of writing every response from scratch.

## What you get

- `kortix.yaml` with `support` as the default agent.
- `.kortix/opencode/agents/support.md` — the agent's persona and working
  rules (triage first, escalate what needs a human, close the loop).
- The two skills above, pulled in automatically at clone time.
- The full Kortix runtime floor (tools, plugins, memory) — same as any new
  project, so the first session works with zero extra setup.

## After cloning

Open the project and start a session. Paste in a real support ticket and the
agent will triage it and draft a reply using the skills above. Edit
`support.md` to change the persona, or add more skills from the marketplace
the same way any project would.
