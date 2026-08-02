'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  completeAgentKnowledgeUpload,
  createAgentKnowledgeSource,
  createAgentKnowledgeUpload,
  discardAgentProfileDraft,
  generateAgentProfileSkill,
  getAgentProfile,
  importAgentProfileSkillArchive,
  importAgentProfileSkillFromGitHub,
  installAgentProfileMarketplaceSkill,
  pauseAgentProfileAutomation,
  previewAgentProfile,
  publishAgentProfile,
  revokeAgentKnowledgeSource,
  syncAgentKnowledgeSource,
  testAgentProfileDraft,
  updateAgentProfileDraft,
  uploadAgentKnowledgeFile,
} from '../core/rest/projects-client';
import { changeRequestsKey } from './use-change-requests';

export const agentProfileKey = (
  projectId: string | null | undefined,
  agentName: string | null | undefined,
) => ['agent-profile', projectId, agentName] as const;

export function useAgentProfile(
  projectId: string | null | undefined,
  agentName: string | null | undefined,
) {
  return useQuery({
    queryKey: agentProfileKey(projectId, agentName),
    queryFn: () => getAgentProfile(projectId as string, agentName as string),
    enabled: !!projectId && !!agentName,
  });
}

export function useAgentProfileMutations(
  projectId: string | null | undefined,
  agentName: string | null | undefined,
) {
  const queryClient = useQueryClient();
  const invalidateProfile = () =>
    queryClient.invalidateQueries({
      queryKey: agentProfileKey(projectId, agentName),
    });
  const invalidatePublication = () => {
    invalidateProfile();
    queryClient.invalidateQueries({ queryKey: changeRequestsKey(projectId) });
    queryClient.invalidateQueries({ queryKey: ['project-config', projectId] });
    queryClient.invalidateQueries({
      queryKey: ['project-detail', projectId, 'agents'],
    });
  };

  const updateDraft = useMutation({
    mutationFn: (input: Parameters<typeof updateAgentProfileDraft>[2]) =>
      updateAgentProfileDraft(projectId as string, agentName as string, input),
    onSuccess: invalidateProfile,
    onError: invalidateProfile,
  });
  const preview = useMutation({
    mutationFn: () => previewAgentProfile(projectId as string, agentName as string),
  });
  const testDraft = useMutation({
    mutationFn: (input: Parameters<typeof testAgentProfileDraft>[2]) =>
      testAgentProfileDraft(projectId as string, agentName as string, input),
  });
  const publish = useMutation({
    mutationFn: (input: Parameters<typeof publishAgentProfile>[2]) =>
      publishAgentProfile(projectId as string, agentName as string, input),
    onSuccess: invalidatePublication,
  });
  const discard = useMutation({
    mutationFn: (input: Parameters<typeof discardAgentProfileDraft>[2]) =>
      discardAgentProfileDraft(projectId as string, agentName as string, input),
    onSuccess: invalidateProfile,
  });
  const pauseAutomation = useMutation({
    mutationFn: (automationSlug: string) =>
      pauseAgentProfileAutomation(projectId as string, agentName as string, automationSlug),
    onSuccess: invalidateProfile,
  });
  const createKnowledgeSource = useMutation({
    mutationFn: (input: Parameters<typeof createAgentKnowledgeSource>[2]) =>
      createAgentKnowledgeSource(projectId as string, agentName as string, input),
    onSuccess: invalidateProfile,
  });
  const createKnowledgeUpload = useMutation({
    mutationFn: (input: Parameters<typeof createAgentKnowledgeUpload>[2]) =>
      createAgentKnowledgeUpload(projectId as string, agentName as string, input),
    onSuccess: invalidateProfile,
  });
  const completeKnowledgeUpload = useMutation({
    mutationFn: (args: {
      sourceId: string;
      input: Parameters<typeof completeAgentKnowledgeUpload>[3];
    }) =>
      completeAgentKnowledgeUpload(
        projectId as string,
        agentName as string,
        args.sourceId,
        args.input,
      ),
    onSuccess: invalidateProfile,
  });
  const uploadKnowledge = useMutation({
    mutationFn: (input: Parameters<typeof uploadAgentKnowledgeFile>[2]) =>
      uploadAgentKnowledgeFile(projectId as string, agentName as string, input),
    onSuccess: invalidateProfile,
  });
  const syncKnowledge = useMutation({
    mutationFn: (sourceId: string) =>
      syncAgentKnowledgeSource(projectId as string, agentName as string, sourceId),
    onSuccess: invalidateProfile,
  });
  const revokeKnowledge = useMutation({
    mutationFn: (sourceId: string) =>
      revokeAgentKnowledgeSource(projectId as string, agentName as string, sourceId),
    onSuccess: invalidateProfile,
  });
  const importSkillArchive = useMutation({
    mutationFn: (input: Parameters<typeof importAgentProfileSkillArchive>[2]) =>
      importAgentProfileSkillArchive(projectId as string, agentName as string, input),
    onSuccess: invalidateProfile,
  });
  const installMarketplaceSkill = useMutation({
    mutationFn: (input: Parameters<typeof installAgentProfileMarketplaceSkill>[2]) =>
      installAgentProfileMarketplaceSkill(projectId as string, agentName as string, input),
    onSuccess: invalidateProfile,
  });
  const importGitHubSkill = useMutation({
    mutationFn: (input: Parameters<typeof importAgentProfileSkillFromGitHub>[2]) =>
      importAgentProfileSkillFromGitHub(projectId as string, agentName as string, input),
    onSuccess: invalidateProfile,
  });
  const generateSkill = useMutation({
    mutationFn: (input: Parameters<typeof generateAgentProfileSkill>[2]) =>
      generateAgentProfileSkill(projectId as string, agentName as string, input),
    onSuccess: invalidateProfile,
  });

  return {
    updateDraft,
    preview,
    testDraft,
    publish,
    discard,
    pauseAutomation,
    createKnowledgeSource,
    createKnowledgeUpload,
    completeKnowledgeUpload,
    uploadKnowledge,
    syncKnowledge,
    revokeKnowledge,
    importSkillArchive,
    installMarketplaceSkill,
    importGitHubSkill,
    generateSkill,
  };
}
