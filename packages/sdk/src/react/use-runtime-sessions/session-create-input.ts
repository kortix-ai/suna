import type { HarnessAuthKind } from '../../core/rest/projects-client';

export interface RuntimeSessionModelSelection {
  kind: 'default' | 'preset' | 'custom';
  modelId?: string | null;
  connectionId?: HarnessAuthKind | null;
}

export interface RuntimeSessionCreateInput {
  title?: string;
  initialPrompt?: string;
  /** Immutable boot agent for the session — mirrors the project-scoped
   *  `buildNewSessionCreateInput` contract so a picked agent actually binds
   *  the runtime session, not just the pre-session composer display. */
  agentName?: string;
  connectionId?: HarnessAuthKind;
  modelSelection?: RuntimeSessionModelSelection;
}

export interface RuntimeSessionCreateBody {
  name?: string;
  initial_prompt?: string;
  agent_name?: string;
  connection_id?: HarnessAuthKind;
  model_selection?: {
    kind: 'default' | 'preset' | 'custom';
    model_id?: string | null;
    connection_id?: HarnessAuthKind | null;
  };
}

/**
 * Build the platform `POST /projects/:id/sessions` body for the instance
 * dashboard's runtime-session create path. Mirrors
 * `buildNewSessionCreateInput` (apps/web new-session-create.ts) — the two
 * composers collect the same {agent, model/connection} selection shape, so
 * both forward it the same way. Fields are omitted rather than sent as
 * `undefined` so an untouched selector changes nothing (server defaults
 * apply exactly as before this input existed).
 */
export function buildRuntimeSessionCreateInput(input: RuntimeSessionCreateInput): RuntimeSessionCreateBody {
  const body: RuntimeSessionCreateBody = {
    ...(input.title ? { name: input.title } : {}),
    ...(input.initialPrompt?.trim() ? { initial_prompt: input.initialPrompt.trim() } : {}),
    ...(input.agentName ? { agent_name: input.agentName } : {}),
    ...(input.connectionId ? { connection_id: input.connectionId } : {}),
  };
  if (input.modelSelection) {
    body.model_selection = {
      kind: input.modelSelection.kind,
      model_id: input.modelSelection.modelId ?? null,
      connection_id: input.modelSelection.connectionId ?? input.connectionId ?? null,
    };
  }
  return body;
}
