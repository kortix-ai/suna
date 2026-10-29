---
title: "Open-source agent tool access starts at the credential boundary"
description: "How to give AI agents production tool access without raw API keys: scoped connectors, approval policies, server-side credentials, and reviewed work."
date: "2026-07-07"
canonical: "https://kortix.com/blog/secure-ai-agent-tool-access"
author: "team"
tags: ["Security", "Connectors", "Enterprise"]
updated: "2026-10-21"
slug: "/secure-ai-agent-tool-access"
cover: "/banner.png"
---
Handing an agent a Stripe key is a decision about where that key lives. The model's instructions are the least reliable part of the arrangement, since everything in a context window competes with them. Kortix is the open-source AI Operating System. Its position is simple: connector credentials stay outside the sandbox, and the rules that govern each call sit in the project repository, where a reviewer can read them.

## The blast radius belongs to the tools

A chat window that drafts a refund email risks an embarrassing sentence. An agent that can call Stripe risks money. The reach of a compromised session is the reach of its connected tools. Agent security keeps turning into tool security. [Auth0's API Keys and AI Agents: Four Common Risks](https://auth0.com/blog/api-key-security-for-ai-agents) names four: leaked keys, over-privileged tokens, prompt injection, and no audit trail.

That framing makes the useful question concrete. Which credential does this call use, who can trigger it, and what happens before a write leaves the machine? A careful prompt answers none of those. A prompt is a suggestion the model weighs against everything else in its context, including text that arrived from a document, a web page or an inbox. Whatever decides whether the call runs has to sit outside the model.

## Where the credential sits decides the failure mode

Two credentials look alike in a dashboard and behave nothing alike in a session. A connector credential is brokered server-side. The agent asks for an action, Kortix resolves the secret outside the sandbox, calls the provider, and records what happened. Connector credentials never enter the machine. A secret you grant to an agent is a different object. Environment is the default exposure: the sandbox receives the real value, and any command the agent runs can read it. Egress-enforced is experimental. There the sandbox holds a handle worth nothing on its own, and Kortix substitutes the real value outside the sandbox, only on requests to the HTTPS hosts you list ([secrets](https://kortix.com/docs/project/secrets)). Connector brokering and a granted secret answer different needs, and the difference should decide how much reach an agent gets.

The network does not sort this out for you. Nothing enforces network egress on a session: the sandbox can reach the internet, and no rule polices where a request goes. The `network_egress` block in a manifest is a declaration only. Validation warns that egress is not enforced ([manifest reference](https://kortix.com/docs/project/manifest)). The credential is the boundary that holds, and where it lives deserves more design attention than any line in the system prompt.

## The grant is a file you can read

A support project's reach fits in one short `kortix.yaml`. This manifest declares one connector, sets two rules on it, and grants that connector to one agent.

```
# kortix.yaml, schema version 2
kortix_version: 2
default_agent: support

connectors:
  - slug: stripe
    name: Stripe
    provider: openapi
    spec: https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json
    policies:
      - match: "get_*"
        action: always_run
      - match: "*"
        action: require_approval

agents:
  support:
    connectors: [stripe]
    secrets: none
    kortix_permissions: none
  release-bot:
    connectors: none
    secrets: none
    kortix_permissions: [project.gitops.push, project.review.submit]
```

Read it as three answers. `default_agent` names the agent a session starts as. The connector is declared once for the project, and its rules are relative to it. Every `get_*` action runs, and every other action, writes included, waits for a person. The `agents` block holds governance only. `support` receives Stripe and no secret at all, while `release-bot` receives no connector and can push a branch and open a change request. Connecting an app to a project and granting it to an agent are separate acts. The file makes that visible in two lines.

The manifest is checked before it runs. `kortix validate` reads it against the schema. `kortix ship` runs the same check before it pushes ([CLI reference](https://kortix.com/docs/cli)). An agent that has no grant for a connector has no way to call it, whatever its instructions say.

## Allow, Ask and Block run at call time

The three actions on a connector are Allow, Ask and Block. Kortix evaluates them when a call is made. An Ask holds the call: the agent's turn pauses and resumes when a person decides. That approval covers one exact request, with the same connector, action, arguments and account, so a changed argument needs a new decision. The approval shows the redacted arguments the provider will receive. The decision goes back into the session ([connectors](https://kortix.com/docs/connect/connectors)). Every action is recorded. Reading, exporting and streaming the audit log depend on the plan.

Approval gates you set. Off until you set them. `policy.default_mode` falls back to `allow_all`, which runs every action no rule matched, reads and writes alike ([connectors](https://kortix.com/docs/connect/connectors)). It is the first thing to change on a project that can touch money. Setting `default_mode: risk` holds writes and destructive actions while reads run. A connector rule or a project-wide rule then narrows one action at a time. Rules can test arguments too, so a message to one domain can run while every other recipient waits.

## The .env shortcut puts the key back in the sandbox

The shortcut that undoes all of this is familiar. Put `STRIPE_SECRET_KEY` and `GITHUB_TOKEN` in a `.env` file, ship the file with the agent, and let the instructions ask for care. It works until the first log line, the first file read, or the first subprocess that prints its environment into a log. The key is also broader than the task, because it carries whatever rights the person who minted it had. The provider's logs then show a shared key, with no record of the agent, session or approval behind a call. Rotating it breaks every workflow that uses it, which is why nobody rotates it.

The alternative costs one line per agent in the manifest. `secrets` is a grant, and an agent that does not list a name does not receive it. That is a small amount of typing for a boundary you can point at in review.

## Durable change arrives as a diff

Policies drift. Someone widens a rule during an incident, the incident ends, and the rule stays. The policy is a file in the repository, so an agent that changes it works on a session branch and proposes the change. Session work reaches `main` through a change request, and merge is default-deny for agents. A reviewer sees the exact rule that will govern tomorrow's calls beside the task that motivated it, and `git revert` is the undo.

A person who manages the project can change connector policy without a change request. Changing a connector rule in the dashboard applies at once, and `kortix connectors policy set --default risk --apply` does the same from a terminal ([connectors](https://kortix.com/docs/connect/connectors)). Agent grants follow the same shortcut on a `kortix_version: 2` manifest: the dashboard and the CLI commit `kortix.yaml` on the default branch, and on v3 a grant change goes through a change request ([agents](https://kortix.com/docs/project/agents)). That is the same boundary seen from the other side: whoever can change policy or grants can widen what an agent may do, which is why the ability belongs with the people who manage the project.

The same manifest that defines the boundary travels with the project. Run it on Kortix Cloud, in your VPC, or on your own on-prem network, and the rules you reviewed are the rules that execute. A company can read its tool access in a repository, review an agent's change as a diff, and point at the credential boundary in a security review. An operator can defend that arrangement to a security questionnaire, and the reviewer can check it without opening a prompt.

```cta
title: Keep the credential out of the agent's reach.
body: Start with one connector, set Ask on the write, and read the grant before it ships. Free to start, free to self-host.
```
