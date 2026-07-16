/**
 * Local mirror of the canonical harness id tuple.
 *
 * Canonical source: `@kortix/shared` `HARNESSES` / `HARNESS_IDS`
 * (`packages/shared/src/harnesses.ts`). This SDK deliberately does not take a
 * runtime dependency on `@kortix/shared` — the SDK core is framework-free and
 * dependency-minimal (only `@kortix/llm-catalog` and `zustand` at runtime), so
 * this module re-declares the harness id tuple locally instead of importing
 * it. The colocated `harness-mirror.drift.test.ts` imports `@kortix/shared`
 * as a devDependency and fails CI on any divergence between the two.
 *
 * Zero imports here — keep it that way.
 */

/** Mirrors `HARNESS_IDS` from `@kortix/shared`. Keep in sync — see drift test. */
export const SDK_HARNESS_IDS = ['claude', 'codex', 'opencode', 'pi'] as const;

export type SdkHarnessId = (typeof SDK_HARNESS_IDS)[number];
