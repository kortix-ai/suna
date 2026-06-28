export type ProjectStarterTemplate = 'minimal' | 'general-knowledge-worker';

export function starterTemplateForManagedProject(
  includeGeneralKnowledgeSkills: boolean,
): ProjectStarterTemplate {
  return includeGeneralKnowledgeSkills ? 'general-knowledge-worker' : 'minimal';
}
