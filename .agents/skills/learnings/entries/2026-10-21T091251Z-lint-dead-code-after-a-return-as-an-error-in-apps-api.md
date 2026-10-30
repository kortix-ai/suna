---
recorded: 2026-10-21T09:12:51Z
incident_date: 2026-10-21
---
# Lint dead code after a return as an error in apps/api

**Rule:** Never leave a statement after a `return`. When you move a line into or out of an early-return block, confirm it still runs on the success path. `apps/api` lints `no-unreachable` as an error.

**Trigger surface:** Editing a route handler that validates, refuses with an early `return c.json(…, 4xx)`, and then writes. This matters most in large refactors that move a validation block.

**Incident:** 2026-10-20, #10547. In `PATCH …/channels/bindings/:bindingId`, `stored = toWireModel(trimmed)` ended up inside `if (!servable) { return …; }`, after the `return`. Every servable model a person pinned to a Slack, Teams or Telegram conversation was saved as `null` and answered 200. It was found by a CLI ↔ API drift audit on 2026-10-21 (KRTX-2987) and fixed on `dev` before any promote. TypeScript only *suggests* on unreachable code by default, so `tsc` stayed green.

**Enforcement:** `'no-unreachable': 'error'` in `apps/api/eslint.config.mjs` (`pnpm --filter kortix-api lint`, 0 existing violations when added). The behavior has a regression test: `apps/api/src/__tests__/integration-channel-binding-model-http.test.ts`.
