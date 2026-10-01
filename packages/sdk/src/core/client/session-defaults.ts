import * as P from '../rest/projects-client';
import type { SessionModel } from './session-shared';
export function bindSessionDefaults(projectId: string, sessionId: string) {
  let _persistedPromptDefaults: Promise<{
    model?: SessionModel;
    agent?: string;
  }> | null = null;

  /**
   * Resolve the server-owned prompt defaults once per handle.
   *
   * A stateful snapshot can contain an existing OpenCode session. OpenCode
   * then reuses that session's last model unless every prompt specifies the
   * current project-session model. Read the persisted Kortix session so the
   * first SDK prompt cannot inherit stale snapshot configuration.
   */
  async function persistedPromptDefaults(): Promise<{
    model?: SessionModel;
    agent?: string;
  }> {
    if (!_persistedPromptDefaults) {
      _persistedPromptDefaults = P.getProjectSession(projectId, sessionId, {
        showErrors: false,
      }).then((projectSession) => {
        const modelReference =
          typeof projectSession.metadata?.opencode_model === 'string'
            ? projectSession.metadata.opencode_model.trim()
            : '';
        const separator = modelReference.indexOf('/');
        const model =
          separator > 0 && separator < modelReference.length - 1
            ? {
                providerID: modelReference.slice(0, separator),
                modelID: modelReference.slice(separator + 1),
              }
            : undefined;
        const agent = projectSession.agent_name?.trim() || undefined;
        return { model, agent };
      });
    }
    try {
      return await _persistedPromptDefaults;
    } catch (error) {
      // A transient read must not poison every later send on this handle.
      _persistedPromptDefaults = null;
      throw error;
    }
  }

  return {
    persistedPromptDefaults,
    clearPersistedDefaults: () => {
      _persistedPromptDefaults = null;
    },
  };
}
