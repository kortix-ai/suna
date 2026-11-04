---
title: The harness architecture diagram for the home page and the README
status: designed, not built; placement decision open
owner: founder (positioning), web (build)
updated: 2026-11-02
---

# The harness architecture diagram

## Problem

Since kortix-brand D35 the home hero subhead and the README tagline call Kortix
"the cloud-native agent harness for companies". No page shows what that harness
is. The home hero band shows two layers (Workspace, Framework); the harness, the
layer that runs everything, has no picture.

The question that settled the model (founder, 2026-11-02): workspace, framework
and harness are not three peer layers. The **harness** is everything around the
model that turns it into a worker: what wakes it, where it runs, what it may
touch, what it remembers, and who checks it. The **framework** (`kortix.yaml`
and pi extensions) is how you modify the harness, so it is a strip under the
diagram, not a third tab. The **workspace** is what people see. A third animated
hero tab was judged too much.

Reference that prompted it: DeepSeek's Super-agent architecture diagram (event
triggers, two-stage filter, router layer, worker sessions, interaction channels,
environments, session database, watchdog).

## The diagram (shipped parts only)

The mock is [`mock.html`](mock.html): open it from this folder; it links the
brand kit's `tokens.css` and `fonts.css`.

Title: "The harness. Everything around the model that turns it into a worker."

| Box | Copy | Kortix source |
|---|---|---|
| Event triggers | Schedules · webhooks · app and connector events · merged changes · loops | Guide "Triggers", "Loops"; developers.mdx "triggers keys" |
| Triggers | A filter in code drops noise, then starts a session or wakes one | `filter` key; session event triggers |
| (dashed arrow) | wakes the session that subscribed | runtime triggers with `target: { session_id }` |
| My Kortix (router) | Shared context, routing and replies. Never blocks: work runs in the background | Guide "The built-in agent", "Several agents at once" |
| Where people are | Web · desktop · mobile · CLI · Slack · Microsoft Teams · email | Guide "Everywhere", "Channels" |
| Custom pi agent, session 1…N | Its own cloud computer, its own permissions, an isolated context; thousands in parallel; each reports back by itself | claims.md "Parallel work", "Harness"; developers.mdx "Agents working together" |
| Your tools, safely | 3,000+ apps · logins held by Kortix, never on the computer · Allow / Ask / Block | Guide "Connectors" |
| LLM gateway | Any model, your keys or ours · budgets and access rules on every call | Guide "Models" |
| State that persists | Git repo · Drive and company memory · each session's record · volumes; a computer sleeps when idle and wakes with its full history | Guide "Computers", "Drive"; `context: record` |
| People approve | Change requests a person ships · approval rules you set | Guide "Review"; claims.md approval rule |
| Framework (dashed strip) | kortix.yaml and pi extensions: every box above is a file in your repo you can change | claims.md "Extensions" |

Left out on purpose: a watchdog (DeepSeek section 6). Kortix ships no
independent session that checks whether workers make progress. Add the box only
when one ships.

## Open decision

Where the diagram lives on the home page:

- **A (recommended):** its own section right under the hero band, as the visual
  for "the cloud-native agent harness" in the subhead.
- **B:** it replaces the Framework tab's animated code view in the hero band.
  Tighter, but the code view is lost.

The README's ASCII diagram (section "A new kind of system") can be replaced by a
rendered image of the same diagram once the page version exists.

## How to pick it up

1. Get the founder's choice between A and B.
2. Build it as a component under `apps/web/src/features/marketing/` from the
   kit primitives; take the box copy from the table above, and re-check every
   claim against `kortix-brand/references/verbal/claims.md`.
3. Localize it (keys in `marketing-release-translation-keys.generated.ts`, all
   9 catalogs), verify at 1440, 1024 and 390 px in light and dark.
4. Hold the PR for the founder (brand and site change).
