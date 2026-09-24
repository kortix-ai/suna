/**
 * new-session-input — the `POST /projects/:id/sessions` body for a
 * project-home send (COR-185). Pure, so the rules test with plain `bun test`;
 * `ProjectScreen.handleDashboardSend` posts the result.
 *
 * The first prompt rides the create in one of three shapes:
 * - with files: `pending_prompt` with its full `parts` (the files are already
 *   uploaded by `useComposerAttachments`, so each part is an `attachment_id`
 *   handle) and `attachment_names`;
 * - text with a model/level pick: `pending_prompt` (a level cannot ride
 *   `initial_prompt`, which carries text only);
 * - plain text: `initial_prompt`.
 */
import type { SessionPromptPart } from '@kortix/sdk';
import type { CreateProjectSessionInput } from '@/lib/projects/projects-client';
import { promptParts } from './prompt-parts';

/** The model and thinking level picked on project home (`firstPromptPicks`). */
type FirstPromptPicks = {
  model: { providerID: string; modelID: string };
  variant: string | null;
} | null;

export function newSessionCreateInput(i: {
  /** Client-generated session id for optimistic navigation. */
  sessionId?: string;
  text: string;
  fileParts: SessionPromptPart[];
  fileNames: string[];
  /** Gateway wire id, or null for the project default. */
  model: string | null;
  picks: FirstPromptPicks;
  agent: string | null;
}): CreateProjectSessionInput {
  const firstPrompt: Pick<CreateProjectSessionInput, 'pending_prompt' | 'initial_prompt'> =
    i.fileParts.length > 0
      ? {
          pending_prompt: {
            text: i.text,
            agent: i.agent,
            model: i.picks?.model ?? null,
            variant: i.picks?.variant ?? null,
            attachment_names: i.fileNames,
            parts: promptParts(i.text, i.fileParts),
          },
        }
      : i.picks
        ? { pending_prompt: { text: i.text, agent: i.agent, model: i.picks.model, variant: i.picks.variant } }
        : { initial_prompt: i.text };
  return {
    ...(i.sessionId ? { session_id: i.sessionId } : {}),
    ...firstPrompt,
    ...(i.model ? { opencode_model: i.model } : {}),
    // The session is bound to this agent; the first prompt runs on it.
    ...(i.agent ? { agent_name: i.agent } : {}),
  };
}
