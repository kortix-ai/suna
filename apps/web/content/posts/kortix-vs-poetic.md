---
title: 'Kortix vs Poetic: both turn workflows into code — the difference is who owns the code'
description: Poetic compiles your procedures into a purpose-built language it runs for you. Kortix keeps the workflow as ordinary code in a repo you own, and gates the boundary where it touches the world. A technical comparison of two answers to the same problem.
date: '2026-07-31'
author: marko
tags:
  - Comparisons
  - Architecture
  - Open Source
cover: /banner.png
coverLogos:
  - domain: poetic.com
    name: Poetic
canonical: https://kortix.com/blog/kortix-vs-poetic
readingTime: 9
lead: 'Poetic and Kortix start from the same observation: an agent that improvises a high-stakes process a thousand times a day will not do it the same way a thousand times. The fix both companies reach for is code — pin the workflow to something you can read, review and re-run. Where the two diverge is what that code is, where it lives, and who ends up holding it. That is the whole comparison, and it is a real one.'
---

```logos
label: 'Compared here:'
items:
  - domain: poetic.com
    name: Poetic
```

## What Poetic actually is

Everything in this section comes from Poetic’s own material — their [site](https://poetic.com/) and their [Series A announcement](https://www.prnewswire.com/news-releases/poetic-raises-50m-series-a-to-automate-the-worlds-most-complex-enterprise-processes-with-reliable-ai-302796939.html). Where their public material does not answer a question, this post says so rather than guessing.

- **The pitch is "turn your business into software."** Their framing for the execution model is software that "learns like AI but runs like code."
- **The primitive is a purpose-built programming language.** Their announcement describes a language that lets operators "define complex workflows in natural language, then encodes that expertise into deterministic, near-tokenless execution."
- **Authoring is teaching, not typing.** You upload procedures, recorded sessions and historical examples; Poetic drafts the workflow, then refines it against expert feedback until it is production-ready.
- **The target is narrow and deliberate** — "multi-hour processes that run thousands of times a day" that "demand near-perfect accuracy," in financial services and insurance.
- **Delivery is forward-deployed.** They reached an eight-figure run rate in 2025 with four employees, working directly alongside large enterprise customers.

## What Poetic is genuinely good at

This is not a hit piece, and the strongest thing about Poetic is the part we do not do. Once a procedure is compiled into their language, execution is deterministic and, by their description, near-tokenless. That is a real engineering result with two consequences an agent loop cannot match: the same input produces the same output, and the marginal cost of the ten-thousandth run does not include a frontier model bill. For a dispute investigation that runs continuously against a fixed set of internal systems, that is the correct architecture, and it is why they can publish accuracy figures like 99%+ quality on multi-hour processes.

Kortix does not make a determinism claim, and this post will not pretend otherwise. A Kortix session is a model loop. It is more general and it is less repeatable. If your problem is one well-bounded process, run at enormous volume, where a 1% deviation is a regulatory event, Poetic is purpose-built for exactly that and Kortix is not.

## The same instinct, applied one layer down

Kortix reaches for code too, but it never compiles anything. There is no Kortix language. The workflow is ordinary TypeScript and markdown sitting in a git repo — a `SKILL.md` that tells an agent how your company does a job, a script next to it for the logic that deserves to be pinned down, a `kortix.yaml` that declares the connectors, triggers and policies. You read it with `cat`. You review it with `git diff`. You test the script without an agent anywhere near it.

What Kortix does own is narrower and, we would argue, the part that actually needs owning: the boundary where that code touches the outside world. Every connector call goes through one server-side chokepoint, the Connector gateway, and the typed client is part of [`@kortix/sdk`](https://www.npmjs.com/package/@kortix/sdk).

## What "verifiable" means here, concretely

For Poetic, "verifiable" means the compiled procedure executes deterministically. For Kortix it means something narrower and different: every action that leaves the sandbox is typed, risk-classified, policy-checked, optionally paused for a human, and written to an audit row — and none of that is enforced by the agent, so none of it can be talked out of by the agent. The gateway is the only path.

Every action in the catalog carries a machine-assigned risk. For an HTTP-backed connector it is derived from the method — `GET`/`HEAD`/`OPTIONS` are `read`, `DELETE` is `destructive`, everything else is `write`. For an MCP connector the server’s own `readOnlyHint` and `destructiveHint` annotations are honoured. That classification is what your policy binds against, so a workflow can assert what it is about to do before it does it:

```
import { createKortix } from '@kortix/sdk';

const kortix = createKortix({
  backendUrl: process.env.KORTIX_API_URL!,
  getToken: async () => process.env.KORTIX_TOKEN ?? null,
});
const connectors = process.env.KORTIX_PROJECT_ID
  ? kortix.project(process.env.KORTIX_PROJECT_ID).connectors
  : kortix.connectors;

// The catalog is the contract. Refuse to run if it drifted.
const action = await connectors.describe('stripe.close_dispute');
if (action?.risk !== 'write') {
  throw new Error(`refusing to run: catalog says ${action?.risk ?? 'unknown'}`);
}
```

And here is the shape Poetic targets — read, branch, act — written as a Kortix skill script. Note what is not in it: no API key, no polling loop, no prompt. The branching is a plain `if`. The credential is resolved server-side and never enters the sandbox. A gated write returns an authenticated approval URL, ends the request, and resumes the Kortix session through a durable callback after one human decision:

```
import { type ConnectorCallResult } from '@kortix/sdk';
// `connectors` is the client created above.

type Dispute = { id: string; amount_cents: number };

// 1. Read. risk: 'read' — the gateway never gates this.
const open = await connectors.call<{ disputes: Dispute[] }>('stripe.list_disputes', {
  status: 'needs_response',
  limit: 50,
});
if (!open.ok) throw new Error(`list_disputes failed: ${open.reason ?? open.status}`);

for (const dispute of open.data?.disputes ?? []) {
  // 2. Branch. Ordinary TypeScript — diffable, and testable with no agent.
  if (dispute.amount_cents > 500_00) continue;

  // 3. Act. A gated write returns one approval handoff immediately.
  const result: ConnectorCallResult = await connectors.call('stripe.close_dispute', {
    dispute: dispute.id,
  });

  if (result.status === 'pending_approval') {
    console.log(result.approval_url);
    break; // Kortix resumes this session after the human approves or denies.
  }

  if (!result.ok) throw new Error(`close_dispute ${dispute.id}: ${result.reason}`);
}
```

> Both snippets above type-check under `strict` against the published `@kortix/sdk` source, and the package unit suite covers route selection, the call envelope, error mapping and catalog flattening. The approval handoff, risk classification and audit row are enforced in the gateway, not in this client — a script cannot opt out of them by not calling them.

The honest scope note: the Connector client in `@kortix/sdk` is a typed client for the action boundary. It is not a workflow compiler and it does not make your workflow deterministic. It makes the \*edges\* of your workflow legible. The determinism you get is the determinism of the TypeScript you wrote around it. That is a weaker guarantee than Poetic’s and a more general one.

## Now the part that is actually different: ownership

Poetic’s public material describes the language, the learning loop and the accuracy. It does not describe where the compiled artifact lives, whether you can export it, whether you can run it without Poetic, or what happens to the workflow if you stop paying. Those may all have good answers — they are simply not published, and we are not going to invent them. What we can be specific about is our side.

- **A project is a git repo.** Not a workspace in our cloud — a repository. `kortix init` turns a directory into one; `kortix ship` pushes it up and runs it. Clone it and you have the whole thing.
- **`kortix.yaml` is the manifest.** Connectors, triggers, channels, required secrets, policies and where agent config lives — one file, in your repo, in the diff.
- **Agents and skills are files.** An agent is a markdown persona. A skill is a `SKILL.md` plus the scripts beside it. There is no console where the real definition secretly lives; the file \*is\* the definition, which is why an agent can propose an edit to its own configuration as a change request.
- **Work lands through review.** A session runs on its own isolated cloud computer on its own branch. It reaches `main` only through a change request someone approves.
- **You can self-host it.** Kortix is open source. Run it on your own infrastructure with your own keys and your own models. This is not an air-gapped story — `kortix self-host start` pulls images and reaches a sandbox provider over the network — but the data, the config and the model are yours.
- **Any model.** Bring your own key, or the ChatGPT subscription you already pay for.

Concretely: if Kortix disappeared tomorrow, your skills are still markdown, your logic is still TypeScript, your manifest is still YAML, and the repo still clones. The Connector gateway is the piece you would have to replace, and its client is a 209-line file whose surface is five methods. That asymmetry — a lot of durable artifact, a small replaceable runtime — is the entire ownership argument, and it is the reason we think it is worth stating plainly rather than dressing up.

## Where this comparison does not favour us

- **No determinism claim.** Poetic compiles to deterministic execution. A Kortix session is a model loop. On a single fixed process at extreme volume, that is their win, not ours.
- **No published accuracy number.** Poetic publishes 99%+ on named process types with named enterprise customers. We publish no comparable figure, and we are not going to manufacture one.
- **Per-run cost.** "Near-tokenless" execution beats a frontier model loop on a process that runs thousands of times a day. Bring-your-own-key narrows that gap; it does not close it.
- **Someone has to write the script.** Poetic drafts the workflow from your recordings and documents, with their team alongside you. Kortix expects you to be comfortable in a repo — and an agent will happily write the skill for you, but you still review it.
- **They are further along on one axis.** A purpose-built language for regulated back-office process work is a deeper commitment to that problem than a general runtime will ever be.

## Side by side

```compare
them: Poetic
rows:
  - dimension: Turns workflows into code
    them: Yes — a purpose-built language
    kortix: Yes — ordinary TypeScript + markdown
    lean: both
  - dimension: Deterministic re-execution
    them: Yes — their core claim
    kortix: No — a model loop plus typed calls
    lean: them
  - dimension: Cost per repeat run
    them: Near-tokenless after authoring
    kortix: Model cost per run — any model, your keys
    lean: them
  - dimension: Where the workflow lives
    them: Poetic's platform
    kortix: A git repo you own
  - dimension: Readable as a diff
    them: Not stated publicly
    kortix: '`git diff` — skills, agents, manifest'
  - dimension: Open source
    them: 'No'
    kortix: 'Yes'
  - dimension: Self-hostable
    them: Not stated publicly
    kortix: Yes — your cloud, VPC, on-prem
  - dimension: Choose your models
    them: Vendor-managed
    kortix: Any model — your keys or your subscription
  - dimension: Human approval on risky actions
    them: Expert feedback loop during authoring
    kortix: Gateway pauses the call for a decision
  - dimension: Audit trail on every action
    them: Immutable audit logs
    kortix: One audit row per gateway call
    lean: both
  - dimension: Scope
    them: Deep — regulated, high-volume process work
    kortix: Broad — a workforce across the company
  - dimension: How you start
    them: Forward-deployed engagement
    kortix: '`kortix init` — or self-host today'
```

## When to pick which

```verdict
themLabel: Poetic
them: you have one or a few high-stakes, high-volume, well-bounded processes — fraud investigation, KYC, dispute handling — where near-perfect repeatability is the requirement, and a forward-deployed vendor relationship is a feature rather than a risk.
kortix: 'you want the workflow to stay yours: agents, skills, policies and memory as files in [one repo you own](/blog/introducing-kortix), any model, self-hostable, with a typed and audited boundary on every action agents take [across departments](/enterprise).'
```

These are not mutually exclusive, and pretending otherwise would be dishonest. A bank can reasonably run Poetic on dispute adjudication and Kortix for everything else the company does — the two answer different questions. If the connector boundary is the part you care about, [the secure tool-access model](/blog/secure-ai-agent-tool-access) goes deeper on the gateway. If it is the architecture, [AGI-ready architecture](/blog/agi-ready-architecture) explains why state lives in files rather than a context window. The other two comparisons — [Claude Cowork](/blog/kortix-vs-claude-cowork) and [Glean](/blog/kortix-vs-glean) — cover the desktop and the search layer.

```cta
title: Turn the workflow into code — and keep the code.
body: Connect your tools and hand a Kortix agent a real task. Free to start, free to self-host.
```
