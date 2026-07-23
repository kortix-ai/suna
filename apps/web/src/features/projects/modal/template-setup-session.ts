import { errorToast } from '@/components/ui/toast';
import {
  buildProjectOnboardingPrompt,
  buildTemplateSetupPrompt,
} from '@/features/marketplace/marketplace-setup-prompt';
import { resolveNewSessionAgent } from '@/features/workspace/project-layout/new-session-create';
import {
  createProjectSession,
  getProjectDetail,
  type CreateProjectSessionInput,
  type KortixProject,
} from '@kortix/sdk/projects-client';

import { resolveAutoStartModelSelection } from './onboarding-model-selection';

/**
 * The create payload for an auto-started session, or `null` when this project
 * has nothing usable to start with yet.
 *
 * A session's boot agent is immutable and bound at birth, and the platform
 * refuses a UI-originated start that names no model on a catalog-driven
 * harness (409 MODEL_SELECTION_REQUIRED). Both of those are decided HERE, from
 * the project's own config and capabilities, because these sessions start with
 * no human in the loop to decide either — see `onboarding-model-selection.ts`.
 *
 * Throws on transport/server failure; the callers below treat a throw as an
 * unexpected error worth a toast, and `null` as the ordinary "no model
 * configured yet" state that is not.
 */
async function buildAutoStartInput(
  projectId: string,
): Promise<Pick<CreateProjectSessionInput, 'agent_name' | 'model_selection'> | null> {
  const detail = await getProjectDetail(projectId);
  const agentName = resolveNewSessionAgent(detail.config);
  if (!agentName) return null;

  const resolved = await resolveAutoStartModelSelection(projectId, agentName);
  if (!resolved.start) {
    console.info('Skipping auto-start session — project not ready', {
      projectId,
      agentName,
      reason: resolved.reason,
    });
    return null;
  }
  return {
    agent_name: agentName,
    ...(resolved.selection ? { model_selection: resolved.selection } : {}),
  };
}

/**
 * Cloned from a marketplace item → don't drop the user on an empty project.
 * Starts a setup session that reads the seeded config and wires up its
 * integrations, so the caller can land the user there instead.
 *
 * Returns the new session's id, or `null` if no session was started — either
 * because the project has no usable model yet (an ordinary first-run state,
 * surfaced by the composer's own connect gate on project home, NOT a toast) or
 * because the create genuinely failed (logged and toasted). The caller falls
 * back to the plain project home in both cases.
 */
export async function startTemplateSetupSession(
  project: KortixProject,
  { itemId, title }: { itemId: string; title: string },
): Promise<string | null> {
  try {
    const autoStart = await buildAutoStartInput(project.project_id);
    if (!autoStart) return null;
    const session = await createProjectSession(project.project_id, {
      ...autoStart,
      initial_prompt: buildTemplateSetupPrompt(title),
      name: `Set up ${title.replaceAll('-', ' ')}`,
      metadata: { kind: 'template-setup', item_id: itemId },
    });
    return session.session_id;
  } catch (error) {
    console.error('Failed to start template setup session', error);
    // Carry what actually went wrong. The old generic string swallowed the
    // server's own sentence, which is why "Select a model before starting this
    // agent" had to surface somewhere else instead of being the message here.
    errorToast(
      error instanceof Error
        ? `Project created, but the setup session could not be started: ${error.message}`
        : 'Project created, but the setup session could not be started',
    );
    return null;
  }
}

/**
 * The "agent creation" default for a brand-new (non-cloned) project: start a
 * first session that onboards + personalizes the starter to the user instead of
 * dropping them on an empty project. Returns the session id, or `null` when no
 * session was started — same two cases as `startTemplateSetupSession` above.
 */
export async function startProjectOnboardingSession(
  project: KortixProject,
): Promise<string | null> {
  try {
    const autoStart = await buildAutoStartInput(project.project_id);
    if (!autoStart) return null;
    const session = await createProjectSession(project.project_id, {
      ...autoStart,
      initial_prompt: buildProjectOnboardingPrompt(project.name),
      name: 'Get started',
      metadata: { kind: 'project-onboarding' },
    });
    return session.session_id;
  } catch (error) {
    console.error('Failed to start onboarding session', error);
    errorToast(
      error instanceof Error
        ? `Project created, but the onboarding session could not be started: ${error.message}`
        : 'Project created, but the onboarding session could not be started',
    );
    return null;
  }
}
