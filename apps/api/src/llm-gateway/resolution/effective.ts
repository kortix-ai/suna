import type { Effect } from 'effect';
import { isManagedModelId } from '@kortix/llm-catalog';

// One definition of how a default model/agent is chosen across scopes, shared by
// the gateway's `auto` resolution (chooseDefaultModel → here) and the apps/api
// display/validation path (resolveEffectiveModel in default-model.ts). Keeping
// the precedence in ONE pure function means Slack, the web picker, and the
// gateway can never disagree about what "the default" is.

/** Where an effective model came from — drives honest UI copy ("· project default"). */
export type ModelSource = 'explicit' | 'agent' | 'project' | 'account' | 'platform';
/** Where an effective agent came from. */
export type AgentSource = 'explicit' | 'project' | 'fallback';

const KORTIX_PREFIX = 'kortix/';

/**
 * The GATEWAY WIRE form of a model ref: a managed model is stored/served bare
 * (`glm-5.2`), so strip the opencode-only `kortix/` namespace before it reaches
 * the gateway (pickAutoModel/resolveCandidates/getManagedModel all expect the
 * bare id). BYOK (`provider/model`) and codex (`codex/<id>`) refs pass through.
 * This is what `account_model_preferences` stores and what servability checks.
 */
export function toWireModel(ref: string): string {
  return ref.startsWith(KORTIX_PREFIX) ? ref.slice(KORTIX_PREFIX.length) : ref;
}

/**
 * The OPENCODE ref form: opencode addresses a managed model as `kortix/<id>` (and
 * sends the bare id on the wire), so a bare managed id must be re-prefixed before
 * it's handed to opencode as `opencode_model`. BYOK/codex refs already carry a
 * provider segment and pass through unchanged.
 */
export function toOpencodeModelRef(model: string): string {
  if (model.startsWith(KORTIX_PREFIX)) return model;
  return isManagedModelId(model) ? `${KORTIX_PREFIX}${model}` : model;
}

function isManagedRef(ref: string): boolean {
  return isManagedModelId(toWireModel(ref));
}

/**
 * Pure precedence for the DEFAULT model chain (no explicit/request override —
 * that's handled by the async resolver, which must validate servability):
 *   per-agent default → project default → account default → platform default.
 *
 * The MOST-SPECIFIC present layer wins; the free-tier managed-drop then applies
 * to that single chosen candidate (dropping to the platform default rather than
 * silently downgrading to a less-specific layer — see choose-default-model.test).
 */
export function chooseEffectiveModel(params: {
  agentDefault?: string | null;
  projectDefault?: string | null;
  accountDefault?: string | null;
  freeModelsOnly?: boolean;
}): { model: string | null; source: ModelSource } {
  let candidate: string | null = null;
  let source: ModelSource = 'platform';
  if (params.agentDefault) {
    candidate = params.agentDefault;
    source = 'agent';
  } else if (params.projectDefault) {
    candidate = params.projectDefault;
    source = 'project';
  } else if (params.accountDefault) {
    candidate = params.accountDefault;
    source = 'account';
  }
  if (!candidate) return { model: null, source: 'platform' };
  // Free tier cannot use managed Kortix models; the chosen candidate is dropped
  // to the platform default rather than falling through to a broader layer.
  if (params.freeModelsOnly && isManagedRef(candidate)) return { model: null, source: 'platform' };
  return { model: candidate, source };
}

/**
 * Pure precedence for the effective AGENT:
 *   explicit (channel/session) → project default → 'default'.
 */
export function chooseEffectiveAgent(params: {
  explicit?: string | null;
  projectDefault?: string | null;
}): { agent: string; source: AgentSource } {
  if (params.explicit) return { agent: params.explicit, source: 'explicit' };
  if (params.projectDefault) return { agent: params.projectDefault, source: 'project' };
  return { agent: 'default', source: 'fallback' };
}
