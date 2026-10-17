/**
 * Which harness a project's sessions boot — computed once, consumed twice.
 *
 * `selectSessionHarness` is THE decision. `apps/api` session provisioning
 * (compile-agent-config.ts) rides it to boot the worker, and the web's draft
 * pick (composer-logic.ts `draftCommandText`) rides the same value to spell a
 * picked skill: `/skill:<name>` is a pi-only expansion (pi shares the `/`
 * namespace between prompt templates and skills, so a bare `/name` that
 * collides with a template runs the template, not the skill), while OpenCode
 * ran a skill as a plain `/name`. Reproducing the decision client-side was the
 * drift the KRTX-2543 review flagged: one function, two consumers.
 *
 * Zero runtime deps, like every `@kortix/shared` module: the `RuntimeV2` union
 * mirrors `@kortix/manifest-schema` `RuntimeV2` structurally — apps/api
 * re-exports through its compiler module and TS ties the two by structure.
 */

export type RuntimeV2 = 'opencode' | 'pi';

/** Tolerant `kortix_version` read — mirrors apps/api's own manifest readers
 *  (e.g. `parseManifestString` in projects/triggers.ts), which coerce a
 *  string version too. Real YAML/TOML decode `kortix_version: 2` to a native
 *  number; the string branch is defensive only. */
export function manifestSchemaVersion(manifest: Record<string, unknown>): number {
  const raw = manifest.kortix_version;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') return Number(raw);
  return Number.NaN;
}

/**
 * The harness a NEW or edited session boots, from the two inputs that can ask
 * for pi: the project's `pi_harness` feature flag (on ⇒ pi, whatever the
 * manifest says) and the manifest's `runtime:` field (`pi` ⇒ pi, even with the
 * flag off). Everything else is OpenCode. `runtime: null` is "could not tell"
 * (no manifest, not v2, read/parse failure), which counts as opencode.
 *
 * pi calls models only through the Kortix LLM gateway (kortixd
 * `harness/pi/model.ts`). A project with the `llm_gateway` flag off gets no
 * gateway URL, so it always boots OpenCode, which calls providers directly.
 */
export function selectSessionHarness(input: {
  piHarnessFlag: boolean;
  runtime: RuntimeV2 | null;
  llmGateway: boolean;
}): 'opencode' | 'pi' {
  if (!input.llmGateway) return 'opencode';
  if (input.piHarnessFlag) return 'pi';
  return input.runtime === 'pi' ? 'pi' : 'opencode';
}

/** The harness a parsed manifest selects. `runtime` is a v2 field; anything but `pi` is OpenCode. */
export function manifestRuntime(raw: unknown): RuntimeV2 {
  if (!raw || typeof raw !== 'object' || ![2, 3].includes(manifestSchemaVersion(raw as Record<string, unknown>))) return 'opencode';
  return (raw as Record<string, unknown>).runtime === 'pi' ? 'pi' : 'opencode';
}
