import { errorToast } from '@/components/ui/toast';
import {
  buildProjectOnboardingPrompt,
  buildTemplateSetupPrompt,
} from '@/features/marketplace/marketplace-setup-prompt';
import {
  createProjectSession,
  type KortixProject,
} from '@kortix/sdk/projects-client';

/**
 * Cloned from a marketplace item → don't drop the user on an empty project.
 * Starts a setup session that reads the seeded config and wires up its
 * integrations, so the caller can land the user there instead.
 *
 * Returns the new session's id, or `null` if the setup session couldn't be
 * started (the failure is logged and surfaced via toast; the caller should
 * fall back to the plain project home in that case).
 */
export async function startTemplateSetupSession(
  project: KortixProject,
  { itemId, title }: { itemId: string; title: string },
): Promise<string | null> {
  try {
    const session = await createProjectSession(project.project_id, {
      initial_prompt: buildTemplateSetupPrompt(title),
      name: `Set up ${title.replaceAll('-', ' ')}`,
      metadata: { kind: 'template-setup', item_id: itemId },
    });
    return session.session_id;
  } catch (error) {
    console.error('Failed to start template setup session', error);
    errorToast('Project created, but the setup session could not be started');
    return null;
  }
}

/**
 * The "agent creation" default for a brand-new (non-cloned) project: start a
 * first session that onboards + personalizes the starter to the user instead of
 * dropping them on an empty project. Returns the session id, or `null` on
 * failure (the caller falls back to the plain project home).
 */
export async function startProjectOnboardingSession(
  project: KortixProject,
): Promise<string | null> {
  try {
    const session = await createProjectSession(project.project_id, {
      initial_prompt: buildProjectOnboardingPrompt(project.name),
      name: 'Get started',
      metadata: { kind: 'project-onboarding' },
    });
    return session.session_id;
  } catch (error) {
    console.error('Failed to start onboarding session', error);
    errorToast('Project created, but the onboarding session could not be started');
    return null;
  }
}
