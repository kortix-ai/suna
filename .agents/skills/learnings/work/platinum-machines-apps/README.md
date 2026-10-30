---
title: Platinum Machines and Apps (the sandbox becomes a Machine; Apps move into Platinum)
status: planning — design record written 2026-10-29, 7 decisions open, nothing built; plus a parked, unproven idea (layered primitives, bare-metal marketplace)
owner: Marko Kraemer (decisions), agent sessions (build)
updated: 2026-10-29
---

# Platinum Machines and Apps

## Problem

Kortix Apps runs its own machine layer (wake, idle stop, keep-alive, the
single-writer volume lock) in the Kortix API, two proxy hops in front of the
VM. That causes `202 app_starting` under load and about 300 ms of extra
latency on dev. It also leaves out TCP services, a private network, regions
and custom domains. Platinum has an experimental `/v1/apps` (one VM per App,
HTTP only, `flags.apps_enabled` off by default).

The direction: Platinum's core object becomes a **Machine** (a regular VM,
plus memory-keeping stop, fork and live resize). A Platinum App is a named
group of Machines. Kortix Apps keeps only its product layer.

## Files

- [`design-record.html`](design-record.html): the full record, A to Z. Open it in a
  browser. It has the comparison, the naming and object model, storage
  separate from compute, the split of work, the build order, the risks and the
  7 open decisions with recommendations. Its section "Parked idea" holds an
  unproven, long-term idea: decouple everything into 7 base primitives with
  Apps and similar products on top, and a one-click bare-metal marketplace
  across providers. Not a plan; nothing about providers is verified.
- Kortix machine-layer code that moves to Platinum or is deleted (4,855
  lines): `machines.ts`, `fleet.ts`, `fleet-routes.ts`, `idle-reaper.ts`,
  `public-proxy-runtime.ts`, `public-proxy-handler.ts`, `volumes.ts`,
  `volume-store.ts`, `images.ts`, `hosting.ts`, `deployment-worker.ts`, all
  in `apps/api/src/apps/`.
- Platinum side (kortix-ai/platinum): `apps/api/src/apps/`,
  `apps/api/src/api/apps.ts`.

## How to pick it up

1. Read `design-record.html`, section "Open decisions". Do not start a spec
   until Marko has decided them.
2. Next, check the networking design against Platinum's host-agent code:
   the private network and public IPs. These two items set the cost of
   everything else.
3. Then write the Platinum spec on a Platinum branch: the Machine contract, the
   two storage modes, Apps, and the build order.
4. Shipped text (docs, CLI, PR bodies) never describes Apps as "the Fly model".
   Fly is an internal reference only.
