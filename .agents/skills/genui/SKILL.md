---
name: genui
description: "Generative UI for Kortix: the agent writes typed UI blocks (cards, comparisons, charts, maps, tabs) in OpenUI Lang inside its replies, and web, mobile, and SDK hosts render them through `@kortix/sdk/genui`. Load WHENEVER you design, build, review, or debug generative UI, the `openui` code fence, the `genui` project flag, the genui prompt instructions, a genui component, or the `@kortix/sdk/genui` or `/genui/react` subpaths."
---

# Generative UI (`genui`)

**Status: spec and implementation plan written (2026-10-09), awaiting Jay's review of the plan
and its spec deltas (`references/plan.md` § Spec deltas). No product code exists yet.**

| Path | What it is |
| --- | --- |
| `references/spec.md` | The product spec: problem, goals, architecture, the 17 v1 components, streaming contract, toggle, requirements with acceptance criteria, Phase 4 guards, metrics, phases, risks, open questions |
| `references/plan.md` | Master implementation plan: architecture, global constraints, review focus, spec deltas D1–D12, file map, interface contracts, order of work, delivery |
| `references/plan-1-sdk.md` | `@kortix/sdk/genui` + `/genui/react` + default components (9 tasks; code verified before writing) |
| `references/plan-2-eval.md` | Phase 0 evaluation of 4 models on 46 synthetic cases, go/no-go gate (2 tasks) |
| `references/plan-3-runtime.md` | `genui` flag, `GENUI_ENABLED` kill switch, prompt on OpenCode and pi, channel guards (5 tasks) |
| `references/plan-4-web.md` | Web and desktop renderer, components, charts, map, settings, copy/export, telemetry, verification (8 tasks) |
| `references/plan-5-mobile.md` | Mobile renderer, components, charts, map, settings, copy, device check, OTA (7 tasks) |

## Rules that already hold

1. UI travels as an `openui` fenced block inside the existing `text` part.
   `kortix.transcript.v1` does not change.
2. Only `@kortix/sdk/genui` imports `@openuidev/*`. Pin it to an exact version.
3. Every component has a zod schema, a web renderer, a native renderer, and
   `toMarkdown`. A component enters the prompt only when all four exist.
4. Project flag off = no UI instructions in the prompt.
5. No raw model output reaches Slack, push, email, or the CLI. Run `toMarkdown`.
6. Query, Mutation, Form, Input, and Button are Phase 4 only, with the guards in
   `references/spec.md` §9.
