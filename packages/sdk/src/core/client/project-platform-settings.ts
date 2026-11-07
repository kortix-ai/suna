import * as P from '../rest/projects-client';

import type { DropFirst } from './binding-types';
export function bindProjectPlatformSettings(projectId: string) {
  return {
    modelDefaults: {
      get: () => P.getModelDefaults(projectId),
      set: (input: Parameters<typeof P.setModelDefault>[1]) => P.setModelDefault(projectId, input),
      clear: (params: Parameters<typeof P.clearModelDefault>[1]) =>
        P.clearModelDefault(projectId, params),
    },

    /** Set the agent used when a new project session does not name one explicitly. */
    setDefaultAgent: (agentName: string) => P.updateWorkspaceDefaultAgent(projectId, agentName),

    /** Sandbox templates + snapshot builds — Dockerfile/image/warm-pool config, beyond `sandboxHealth`/`sandboxTemplates`. */
    sandbox: {
      list: () => P.listWorkspaceSandboxes(projectId),
      snapshots: () => P.listWorkspaceSnapshots(projectId),
      rebuildSnapshot: (slug?: string) => P.rebuildWorkspaceSnapshot(projectId, slug),
      fixWithAgent: () => P.fixSandboxWithAgent(projectId),
      createTemplate: (input: Parameters<typeof P.createSandboxTemplate>[1]) =>
        P.createSandboxTemplate(projectId, input),
      updateTemplate: (...a: DropFirst<Parameters<typeof P.updateSandboxTemplate>>) =>
        P.updateSandboxTemplate(projectId, ...a),
      removeTemplate: (templateId: string) => P.deleteSandboxTemplate(projectId, templateId),
      buildTemplate: (templateId: string) => P.buildSandboxTemplate(projectId, templateId),
      /** Pin/clear the per-project sandbox provider (null = follow the platform default). */
      setProvider: (provider: Parameters<typeof P.updateWorkspaceSandboxProvider>[1]) =>
        P.updateWorkspaceSandboxProvider(projectId, provider),
    },

    /** Bind specific secrets + connectors to an agent (the inheritance pyramid's declaration step). */
    setAgentScope: (...a: DropFirst<Parameters<typeof P.setAgentScope>>) =>
      P.setAgentScope(projectId, ...a),
  };
}
