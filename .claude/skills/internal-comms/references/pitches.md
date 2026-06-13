# Kortix Audience Pitches

Companion to `../SKILL.md`. Three primary audiences (Developers, Companies, Enterprise) and one bonus (Agencies & consultancies). All facts trace to `suna/MANIFESTO.md` and `suna/README.md`.

Each pitch: **who → pain → promise → proof/mechanism → sanctioned phrases → what not to say.**

## Developers *(primary)*

- **Who:** Engineers already running coding agents (OpenCode, Claude, Codex) who want them in the cloud, in the background, with state that sticks.
- **Pain:** Agents stuck on one laptop; no shared state, no isolation, no preview per change; every tool wants its own setup.
- **Promise:** A managed cloud for OpenCode, Claude, and Codex agents. One `kortix.toml`, one config, one repo for the state that sticks — and you're running background coding agents.
- **Proof / mechanism:** `kortix init`, `kortix ship` — that's the loop. Every PR gets a preview you can click through. Have your local agent spin up cloud sessions and go wide. Bring the subscription you already pay for.
- **Sanctioned phrases:** "managed cloud for your coding agents," "background agents with a preview per change," "one repo for the state that sticks," "bring your own subscription."
- **Don't say:** "replaces your IDE," "no more code," or anything implying autonomous merge without review — work lands via change request.

## Companies *(primary)*

- **Who:** Teams that want AI doing real work across the business, reachable where people already are.
- **Pain:** Forty disconnected tools; AI that forgets context; output that's chat, not finished work; vendors holding the data.
- **Promise:** A workforce you can actually manage. People talk to it through the web, Slack, or Teams. It picks up the business as it goes — its skills, its context, the specific way the work gets done.
- **Proof / mechanism:** Agents run on real computers and return finished deliverables (decks, reports, code, replies) and take real actions in your tools; work runs on-demand, human-assisted, or automated; the data, config, and model belong to the company, not a vendor.
- **Sanctioned phrases:** "a workforce, not one assistant," "real work, not chat," "run your company from one place you own."
- **Don't say:** "fully autonomous company" (humans approve change requests), invented productivity metrics, or customer names.

## Enterprise *(primary)*

- **Who:** Security, IT, and platform leaders who must put AI in front of a security review.
- **Pain:** AI tools that fold under a security review — no isolation, no permissions, no audit, no on-prem story.
- **Promise:** Built to survive a security review, not slip past one.
- **Proof / mechanism:** microVM isolation; members, groups, and roles that match your org; per-resource permissions for people **and** agents; a secrets manager (encrypted, injected at runtime, never exposed); full audit trail; human approval gates on sensitive actions; on-prem, VPC, or air-gapped deployment.
- **Sanctioned phrases:** "survives a security review," "isolation, permissions, audit, approval gates," "your data, your models, your infrastructure — no lock-in."
- **Don't say:** "certified" or specific compliance claims (SOC 2, ISO, etc.) unless given as fact; "unbreakable" / "100% secure."

## Agencies & consultancies *(bonus)*

- **Who:** Firms bringing AI into their clients who need a platform to bet on.
- **Pain:** Rebuilding the same AI plumbing per client; no durable platform; reselling someone else's locked box.
- **Promise:** One horizontal platform sold through verticalized partners with their own front ends and their own starter templates. A franchise for the part of the economy that's about to get rebuilt.
- **Proof / mechanism:** Partners handle distribution and clients; Kortix provides the technology, the training, and the playbook. Importable projects, agents, and skills via the marketplace.
- **Sanctioned phrases:** "one horizontal platform, verticalized partners," "the technology, the training, and the playbook," "a franchise for the AI rebuild."
- **Don't say:** specific revenue-share or partner terms unless given as fact.
