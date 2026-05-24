<div align="center">

<img src="apps/web/public/Logomark.svg" alt="Kortix" width="80" />

# Kortix

### The AI command center for your company

Kortix is where your company runs on AI — one place where all your context,
agents, triggers, integrations, and memory live, and a workforce of AI agents
does the real work across your tools, around the clock. It feels as simple as a
chat app; underneath, everything is code you own.

[Website](https://kortix.com) · [Documentation](https://kortix.com/docs) · [Cloud](https://kortix.com) · [OpenCode](https://opencode.ai)

![License: Elastic 2.0](https://img.shields.io/badge/License-Elastic%202.0-2563eb)
![Source-available](https://img.shields.io/badge/Source--available-yes-22c55e)
![Runtime: OpenCode](https://img.shields.io/badge/Runtime-OpenCode-111827)

</div>

---

## What is Kortix?

Most AI tools give you a chat box. Kortix gives you a **command center**: one
place where your agents, skills, integrations, automations, and memory all live —
and a workforce of AI agents that produces real output (decks, reports, code,
replies, deployed work), not just chat.

It is **not** a chatbot, a copilot, or a single "AI employee." It's the operating
layer for an AI-native company — accessible to anyone, owned by you.

## What's in the command center

| | |
| --- | --- |
| **Agents** | Your AI coworkers — one per role or task. |
| **Skills & workflows** | Reusable know-how that does a job your way. |
| **Integrations** | 3,000+ tools, connected once and shared across the org. |
| **Chat & sessions** | Where you and your team work with agents, live. |
| **Automations** | Triggers on a schedule, a webhook, or a chat message. |
| **Memory** | A living company brain that compounds over time. |

Work runs three ways: **on-demand** (ask in chat, get it now), **human-assisted**
(the agent works and checks in for the calls that matter), and **automated**
(runs on a schedule or trigger, end to end).

## Quickstart

### Kortix Cloud — managed

Sign up at **[kortix.com](https://kortix.com)**, create a project, and start a
session. Nothing to install.

### From the terminal — for builders

```bash
curl -fsSL https://kortix.com/install | bash   # install the kortix CLI
kortix login                                   # authorize in your browser

kortix init                                    # scaffold a project (kortix.toml + agent config)
kortix ship                                    # create the cloud project and push your repo
kortix sessions new --prompt "Summarize this week's commits and open a change request"
kortix cr ls                                   # review what the agent proposes — then merge to keep it
```

Full command surface: **[CLI reference](https://kortix.com/docs/reference/cli)**.

## How it works

A **Kortix project is one git repository** with a `kortix.toml` manifest at its
root — the single source of truth for the whole company.

```
project  (git repo + kortix.toml)
   └─ session ──> isolated cloud sandbox on a branch named after the session
                     └─ agent (OpenCode) works, commits, pushes
                           └─ change request ──> you review & merge ──> main
```

- Every **session** runs in its own disposable Linux sandbox on its own branch —
  the agent can install, run, and break anything; only what it commits survives.
- Work reaches `main` only through a **change request** you approve, so the
  company self-improves one reviewed change at a time.
- **Triggers** (cron + signed webhooks) and **channels** (Slack) spawn sessions
  automatically.
- **Connections** let agents call your tools (Pipedream, MCP, OpenAPI, GraphQL,
  HTTP), brokered server-side with per-user credentials.
- The agent runtime is **[OpenCode](https://opencode.ai)** — engine- and
  provider-agnostic; bring your own models or use Kortix cloud.

Learn the model: **[Concepts](https://kortix.com/docs/concepts)** ·
**[Reference](https://kortix.com/docs/reference)** ·
**[Quickstart](https://kortix.com/docs/quickstart)**

## Why Kortix

- **Open & yours.** Source-available and self-hostable — your data, your models,
  your infrastructure. No lock-in, fully auditable.
- **A workforce, not one assistant.** Org-scale specialist agents that run in
  parallel and compound a shared memory.
- **Real work, not chat.** Agents run on real computers and return finished
  deliverables — and take real actions in your tools.
- **Everything is code.** Versioned, reviewable, portable, governable — never a
  black box.

## Self-host

Kortix is source-available and runs on your own infrastructure — laptop, VPS,
your VPC, or air-gapped. Bring your own models, and point the CLI at your
instance:

```bash
kortix login --api https://kortix.your-company.com
```

Managed hosting is **[Kortix Cloud](https://kortix.com)** — see
**[Pricing](https://kortix.com/pricing)** for Open Source, Cloud, and Enterprise.

## Enterprise & security

Members, groups & roles that match your org · per-resource permissions for people
**and** agents · a secrets manager (encrypted, injected at runtime, never
exposed) · full audit trail · human approval gates on sensitive actions · on-prem,
VPC, or air-gapped deployment.

## Develop

Monorepo managed with **pnpm 8** (Docker required for sandboxes).

```bash
pnpm install
pnpm dev            # web + API (scripts/dev-local.sh)
pnpm dev:web        # web app only
pnpm dev:api        # API only
pnpm dev:sandbox    # build the local sandbox image
pnpm build          # build all packages
pnpm nuke           # tear down the local Docker environment
```

Apps live under `apps/` (`web`, `api`, `cli`, `mobile`, `sandbox`); the
documentation source is in `apps/web/content/docs`.

## License & naming

- **License:** [Elastic License 2.0](LICENSE) — source-available.
- **Kortix** is the product. **Suna** is the open-source project name (this repo,
  [`kortix-ai/suna`](https://github.com/kortix-ai/suna)). The agent runtime is
  **[OpenCode](https://opencode.ai)**.
