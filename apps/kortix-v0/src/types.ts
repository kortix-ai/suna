export interface Project {
  id: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
  manifestPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRun {
  id: string;
  projectId: string;
  branchName: string;
  baseRef: string;
  sandboxProvider: string;
  agentName: string;
  sandboxId: string | null;
  sandboxUrl: string | null;
  opencodeSessionId: string | null;
  status: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Proposal {
  id: string;
  projectId: string;
  sessionId: string;
  branchName: string;
  status: string;
  diffStatJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface SecretMetadata {
  projectId: string;
  key: string;
  createdAt: string;
  updatedAt: string;
}

export interface EnvRequirements {
  required: string[];
  optional: string[];
}

export interface EnvRequirementStatus {
  key: string;
  required: boolean;
  set: boolean;
  updatedAt: string | null;
}

export interface ProjectSecretsStatus {
  required: EnvRequirementStatus[];
  optional: EnvRequirementStatus[];
  undeclared: EnvRequirementStatus[];
  missingRequired: string[];
}

export interface FileEntry {
  path: string;
  type: "file";
  size: number | null;
}

export interface AgentSummary {
  name: string;
  path: string;
  description: string | null;
  mode: string | null;
}

export interface SkillSummary {
  name: string;
  path: string;
}

export interface ProjectConfig {
  isKortixRepo: boolean;
  signals: Record<string, boolean>;
  manifestRaw: string | null;
  manifest: Record<string, unknown>;
  env: EnvRequirements;
  openCodeRaw: string | null;
  openCodeDefaultAgent: string | null;
  agents: AgentSummary[];
  skills: SkillSummary[];
  hasOpenCodeConfig: boolean;
  hasOpenCodeAgent: boolean;
}
