import { errorToast } from '@/components/ui/toast';
import {
  buildWorkspaceOnboardingPrompt,
  buildTemplateSetupPrompt,
} from '@/features/marketplace/marketplace-setup-prompt';
import {
  createWorkspaceSession,
  type KortixWorkspace,
} from '@kortix/sdk';

/**
 * Cloned from a marketplace item → don't drop the user on an empty workspace.
 * Starts a setup session that reads the seeded config and wires up its
 * connections, so the caller can land the user there instead.
 *
 * Returns the new session's id, or `null` if the setup session couldn't be
 * started (the failure is logged and surfaced via toast; the caller should
 * fall back to the plain workspace home in that case).
 */
export async function startTemplateSetupSession(
  workspace: KortixWorkspace,
  { itemId, title }: { itemId: string; title: string },
): Promise<string | null> {
  try {
    const session = await createWorkspaceSession(workspace.workspace_id, {
      initial_prompt: buildTemplateSetupPrompt(title),
      name: `Set up ${title.replaceAll('-', ' ')}`,
      metadata: { kind: 'template-setup', item_id: itemId },
    });
    return session.session_id;
  } catch (error) {
    console.error('Failed to start template setup session', error);
    errorToast('Workspace created, but the setup session could not be started');
    return null;
  }
}

/**
 * The "agent creation" default for a brand-new (non-cloned) workspace: start a
 * first session that onboards + personalizes the starter to the user instead of
 * dropping them on an empty workspace. Returns the session id, or `null` on
 * failure (the caller falls back to the plain workspace home).
 */
export async function startWorkspaceOnboardingSession(
  workspace: KortixWorkspace,
): Promise<string | null> {
  try {
    const session = await createWorkspaceSession(workspace.workspace_id, {
      initial_prompt: buildWorkspaceOnboardingPrompt(workspace.name),
      name: 'Get started',
      metadata: { kind: 'workspace-onboarding' },
    });
    return session.session_id;
  } catch (error) {
    console.error('Failed to start onboarding session', error);
    errorToast('Workspace created, but the onboarding session could not be started');
    return null;
  }
}
