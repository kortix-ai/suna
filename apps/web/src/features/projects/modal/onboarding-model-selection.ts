/**
 * What model (if any) a system-started session must name at birth.
 *
 * The platform refuses a UI-originated session start that names no model when
 * the agent's harness doesn't own its own default — `requiresExplicitModelSelection`
 * in `apps/api/src/projects/lib/session-model-selection.ts`, answering with 409
 * MODEL_SELECTION_REQUIRED / "Select a model before starting this agent." That
 * gate is correct for a human clicking send: it forces an explicit choice
 * instead of a silent arbitrary default.
 *
 * But the auto-started onboarding and template-setup sessions have no human in
 * the loop to make that choice, and they sent nothing — so on the default
 * starter (`default_agent: kortix` on OpenCode, `ownsDefaultModel: false`) they
 * failed 100% of the time, on every project, whether or not the account had a
 * model connected. The user saw "Project created, but the onboarding session
 * could not be started".
 *
 * So the choice is made here, from the same two facts the composer itself
 * reads: what the project can actually start (`getComposerCapabilities`) and
 * what model this account has configured (`getModelDefaults`). If neither can
 * produce a usable model, the honest answer is not to start a session at all —
 * the caller lands the user on project home, where the composer's own
 * connect-a-model gate is the real next step.
 */

import type {
  ComposerCapabilities,
  CreateProjectSessionInput,
  ModelDefaultsResponse,
} from '@kortix/sdk/projects-client';
import { getComposerCapabilities, getModelDefaults } from '@kortix/sdk/projects-client';
import { HARNESSES } from '@kortix/shared';

export type AutoStartModelSelection =
  /** Don't start a session. `reason` is the platform's own blocking sentence,
   *  for logging — the user is shown the composer's gate, not a toast. */
  | { start: false; reason: string | null }
  /** Start it. `selection` is `undefined` for a harness that owns its default
   *  model, where naming one would OVERRIDE the user's subscription. */
  | { start: true; selection: CreateProjectSessionInput['model_selection'] | undefined };

/**
 * The configured default for an agent, in the platform's own precedence order:
 * agent → project → account → platform. Mirrors `useModelDefaults`'
 * `resolveDefaultFor` so an auto-started session picks the same model the
 * composer would have shown the user a second later.
 */
function resolveDefaultModel(
  defaults: ModelDefaultsResponse,
  agentName: string,
): string | undefined {
  return (
    defaults.agentDefaults?.[agentName] ||
    defaults.projectDefault ||
    defaults.accountDefault ||
    defaults.platformDefault ||
    undefined
  );
}

/** Pure decision, split from the I/O so every branch is unit-testable. */
export function pickAutoStartModelSelection(input: {
  capabilities: ComposerCapabilities;
  defaults: ModelDefaultsResponse;
  agentName: string;
}): AutoStartModelSelection {
  const { capabilities, defaults, agentName } = input;

  // `can_start` is the platform's single readiness fact — `capabilities()`
  // derives it, `auth.ready` and `model.default_allowed` from one
  // `resolveHarnessModels` call. Nothing is re-derived here.
  if (!capabilities.can_start) {
    return { start: false, reason: capabilities.blocking_reason };
  }

  // Claude Code and Codex supply their own default model from the
  // authenticated subscription, so the gate never fires for them — and their
  // `presets` are a curated OVERRIDE SUGGESTION list (see `modelPresets`), not
  // the connection's model set. Naming one would quietly override the user's
  // subscription default on their very first session.
  if (HARNESSES[capabilities.agent.harness]?.ownsDefaultModel) {
    return { start: true, selection: undefined };
  }

  // Catalog-driven harness (OpenCode, Pi): an explicit pick is mandatory.
  const presets = capabilities.model.presets;
  const preferred = resolveDefaultModel(defaults, agentName);
  // Match by preset id before trusting the default. Model defaults are gateway
  // WIRE models (`glm-5.2`, `codex/gpt-5.6-sol`); presets come from the
  // resolved catalog, and the API rejects a `preset` whose model_id isn't in
  // the list (INVALID_MODEL_SELECTION). A namespace mismatch must degrade to a
  // working model, not a 400.
  const pick = presets.find((preset) => preset.id === preferred) ?? presets[0];
  if (!pick) {
    // Startable with an empty catalog: `model.default_allowed` tracks
    // `can_start`, so "no override, use what the runtime resolves" is a legal
    // answer and still satisfies the gate.
    return { start: true, selection: { kind: 'default' } };
  }
  return {
    start: true,
    selection: {
      kind: 'preset',
      model_id: pick.id,
      connection_id: capabilities.auth.active,
    },
  };
}

/**
 * Fetch both inputs and decide. Throws only on genuine transport/server
 * failure — the caller treats a throw as an unexpected error worth surfacing,
 * and `{ start: false }` as the ordinary "this account has no model yet" state.
 */
export async function resolveAutoStartModelSelection(
  projectId: string,
  agentName: string,
): Promise<AutoStartModelSelection> {
  const [capabilities, defaults] = await Promise.all([
    getComposerCapabilities(projectId, agentName),
    getModelDefaults(projectId),
  ]);
  return pickAutoStartModelSelection({ capabilities, defaults, agentName });
}
