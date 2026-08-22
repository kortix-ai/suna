# Web SDK-only boundary implementation plan

**Spec:** `docs/superpowers/specs/2026-07-24-web-sdk-only-boundary-design.md`

## Task 1: Baseline and static boundary gate

- Record the current production dependency inventory.
- Add a failing static test for forbidden frontend dependencies.
- Add ESLint restrictions for direct OpenCode and legacy runtime imports.
- Commit the baseline and RED evidence.

## Task 2: Canonical SDK imports

- Replace deprecated SDK subpath imports with `@kortix/sdk` or
  `@kortix/sdk/react`.
- Replace host-local re-export imports with canonical SDK imports.
- Delete pure compatibility re-export files from `apps/web`.
- Keep the static boundary test green for completed categories.

## Task 3: One session engine

- Add failing SDK and web tests for one lifecycle and chat engine.
- Move remaining reusable chat state and mutations into `useSession`.
- Make the session page mount `useSession` with its complete engine.
- Make `SessionChat` consume the supplied SDK session state.
- Remove duplicate sync, question-heal, event, and runtime-client calls.

## Task 4: Runtime-neutral web state

- Move host-local model, provider, pending, compaction, and queue behavior into
  SDK surfaces where the behavior is portable.
- Keep presentation-only state in `apps/web`.
- Remove web runtime stores and OpenCode-named web hooks.
- Preserve deprecated SDK aliases for external consumers.

## Task 5: Typed platform API coverage

- Inventory browser and Next.js server calls to the Kortix API.
- Add missing typed SDK functions with failing tests first.
- Migrate each call site to the SDK.
- Use request-scoped server SDK clients for server actions and route handlers.
- Remove host-owned Kortix endpoint paths and response parsing.

## Task 6: Remove runtime routing knowledge

- Replace runtime proxy URL construction with session-scoped SDK methods.
- Replace file, PTY, preview, and health calls with SDK surfaces.
- Remove direct runtime clients from `apps/web`.
- Reduce the static boundary allowlist to zero.

## Task 7: Local parity proof

- Run SDK typecheck, tests, and packed-install smoke.
- Run focused web tests and ESLint.
- Run the relevant web typecheck and filter known React mismatch noise.
- Start the isolated stack.
- Exercise every feature-parity gate with real browser, HTTP, and sandbox
  inputs.
- Run the white-label reference demo against the same SDK.

## Task 8: Delivery and dev proof

- Update SDK documentation and `PROGRESS.md`.
- Push the branch and open a PR against `main`.
- Wait for required checks and merge.
- Follow Deploy Dev to completion.
- Confirm the deployed artifact contains the merge SHA.
- Repeat the user-visible session, file, PTY, and white-label proofs on dev.
