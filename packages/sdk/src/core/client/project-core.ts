import { createPromptAttachmentController } from '../attachments/prompt-attachments';
import * as P from '../rest/projects-client';
import type { DropFirst } from './binding-types';
export function bindProjectCore(projectId: string) {
  return {
    attachments: {
      upload: (...args: DropFirst<Parameters<typeof P.uploadPromptAttachment>>) =>
        P.uploadPromptAttachment(projectId, ...args),
      delete: (...args: DropFirst<Parameters<typeof P.deletePromptAttachment>>) =>
        P.deletePromptAttachment(projectId, ...args),
      createController: (options?: Parameters<typeof createPromptAttachmentController>[1]) =>
        createPromptAttachmentController(projectId, options),
    },
    get: (opts?: Parameters<typeof P.getProject>[1]) => P.getProject(projectId, opts),
    detail: () => P.getWorkspaceDetail(projectId),
    skills: {
      remove: (...a: DropFirst<Parameters<typeof P.removeWorkspaceSkill>>) =>
        P.removeWorkspaceSkill(projectId, ...a),
      /** Create a skill file on the default branch — no model needed. */
      create: (...a: DropFirst<Parameters<typeof P.createWorkspaceSkill>>) =>
        P.createWorkspaceSkill(projectId, ...a),
    },
    /** Canonical project-scoped audit timeline. */
    audit: (options?: Parameters<typeof P.listWorkspaceAudit>[1]) =>
      P.listWorkspaceAudit(projectId, options),
    update: (input: Parameters<typeof P.updateProject>[1]) => P.updateProject(projectId, input),
    archive: () => P.archiveWorkspace(projectId),
    llmCatalog: () => P.getWorkspaceLlmCatalog(projectId),
    /** The live provider catalogue (models.dev, refreshed hourly): what `buildLlmProviderCatalog` turns into rows. */
    llmCatalogProviders: () => P.getWorkspaceLlmCatalogProviders(projectId),
    modelPicker: () => P.getWorkspaceModelPicker(projectId),
    modelAccess: () => P.getWorkspaceModelAccess(projectId),
    setModelAccess: (change: P.ProjectModelAccessChange) =>
      P.setWorkspaceModelAccess(projectId, change),
    /** The project's custom OpenAI-compatible providers. */
    customLlmProviders: () => P.listCustomLlmProviders(projectId),
    setCustomLlmProvider: (providerId: string, input: P.CustomLlmProviderInput) =>
      P.putCustomLlmProvider(projectId, providerId, input),
    /** Deletes the definition and its `CUSTOM_<ID>_API_KEY` secret. */
    deleteCustomLlmProvider: (providerId: string) => P.deleteCustomLlmProvider(projectId, providerId),
    sandboxHealth: () => P.getWorkspaceSandboxHealth(projectId),
    onboardingComplete: (...a: DropFirst<Parameters<typeof P.setWorkspaceOnboardingComplete>>) =>
      P.setWorkspaceOnboardingComplete(projectId, ...a),
  };
}
