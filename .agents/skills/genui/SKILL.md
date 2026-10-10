---
name: genui
description: "Generative UI for Kortix: the agent writes typed UI blocks (cards, comparisons, charts, maps, tabs) in OpenUI Lang inside its replies, and web, mobile, and SDK hosts render them through `@kortix/sdk/genui`. Load WHENEVER you design, build, review, or debug generative UI, the `openui` code fence, the `genui` project flag, the genui prompt instructions, a genui component, or the `@kortix/sdk/genui` or `/genui/react` subpaths."
---

# Generative UI (`genui`)

**Status (2026-10-10): built on branch `genui`, not merged to `dev`.** SDK (`@kortix/sdk/genui`, `/genui/react`), runtime (`genui` flag, prompt on OpenCode and pi, channel guards), web, and mobile are implemented. Plans 1–5 are built. Open: plan-4 task 8 (full `pnpm test` attestation, browser checks), and plan-5 task 7's device check and OTA publish, which wait on Jay (`references/mobile-device-check.md`).

Phase 0 (provisional, local stand-in models): GO (2026-10-09, prompt 00a9030e). Valid: deepseek-v4.1-flash 100.0%, glm-5.3-flash 100.0%, gate 97.0%; kimi-k3 unavailable (503); Jay's 4 models untested. See `references/eval-results.md`.

| Path | What it is |
| --- | --- |
| `references/spec.md` | The product spec: problem, goals, architecture, the 17 v1 components, streaming contract, toggle, requirements with acceptance criteria, Phase 4 guards, metrics, phases, risks, open questions |
| `references/plan.md` | Master implementation plan: architecture, global constraints, review focus, spec deltas D1–D12, file map, interface contracts, order of work, delivery |
| `references/plan-1-sdk.md` | `@kortix/sdk/genui` + `/genui/react` + default components (9 tasks; code verified before writing) |
| `references/plan-2-eval.md` | Phase 0 evaluation of 4 models on 46 synthetic cases, go/no-go gate (2 tasks) |
| `references/plan-3-runtime.md` | `genui` flag, `GENUI_ENABLED` kill switch, prompt on OpenCode and pi, channel guards (5 tasks) |
| `references/plan-4-web.md` | Web and desktop renderer, components, charts, map, settings, copy/export, telemetry, verification (8 tasks) |
| `references/plan-5-mobile.md` | Mobile renderer, components, charts, map, settings, copy, device check, OTA (7 tasks) |
| `references/eval-results.md` | Phase 0 results: one summary table per eval run, appended by `scripts/eval.ts` |
| `references/mobile-device-check.md` | On-device checklist for mobile (Jay runs it), the OTA publish procedure, the old-build check |
| `scripts/eval.ts` | Phase 0 runner: every case against each model through the LLM gateway; writes `output/genui-eval/` and appends `eval-results.md` |
| `scripts/eval-prompts.json` | The 46 synthetic eval cases: prompt, optional tool result (`context`), expected UI use (`expect`), forbidden components (`forbid`) |
| `scripts/score.ts`, `scripts/score.test.ts` | Scores one reply (valid blocks, overuse, underuse, forbidden components) and applies the go/no-go gate |

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
7. A Map draws tiles only from a style we configure: web
   `NEXT_PUBLIC_GENUI_MAP_STYLE_URL` (optional `NEXT_PUBLIC_GENUI_MAP_STYLE_URL_DARK`),
   mobile `EXPO_PUBLIC_GENUI_MAP_STYLE_URL`. Unset, it renders the place list with
   OpenStreetMap links. Never mapcn's CARTO default (commercial license). Web
   loads MapLibre only with a style set, and serves its worker from `/maplibre/`
   (copied out of node_modules by `apps/web/scripts/viewer-wasm.mjs`).
8. A node that fails its schema never takes valid content with it. `sanitizeTree`
   (`packages/sdk/src/genui/validate.ts`) puts its valid subtrees in its place, in
   source order. A subtree the parent slot cannot hold rises to the nearest ancestor
   that can (any block fits a Stack); a non-block gives up its own children. A root
   that fails becomes a Stack of its subtrees. Only a block with no valid subtree
   has `root: null`.
9. Every host runs `separateGenuiClosers` (`@kortix/sdk/genui/fence`) on reply text
   before it looks for fences: it moves a closer the model glued to the last
   statement (`…")````) onto its own line. `genuiToMarkdown` runs it itself. The
   web (`unified-markdown.tsx`), mobile (`selectable-markdown.tsx`) and
   `scripts/score.ts` call it directly.
