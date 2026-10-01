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
    detail: () => P.getProjectDetail(projectId),
    /** Canonical project-scoped audit timeline. */
    audit: (options?: Parameters<typeof P.listProjectAudit>[1]) =>
      P.listProjectAudit(projectId, options),
    update: (input: Parameters<typeof P.updateProject>[1]) => P.updateProject(projectId, input),
    archive: () => P.archiveProject(projectId),
    llmCatalog: () => P.getProjectLlmCatalog(projectId),
    modelPicker: () => P.getProjectModelPicker(projectId),
    modelAccess: () => P.getProjectModelAccess(projectId),
    setModelAccess: (change: P.ProjectModelAccessChange) =>
      P.setProjectModelAccess(projectId, change),
    sandboxHealth: () => P.getProjectSandboxHealth(projectId),
    onboardingComplete: (...a: DropFirst<Parameters<typeof P.setProjectOnboardingComplete>>) =>
      P.setProjectOnboardingComplete(projectId, ...a),

  };
}
