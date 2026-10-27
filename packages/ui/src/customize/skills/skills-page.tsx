'use client';

import type { ReactNode } from 'react';

import { CapabilityLibrary, type CapabilityAgent } from '../shared/capability-library';

/**
 * Skills: the one component for Project admin → Skills and an agent's
 * Access → Skills (`CapabilityLibrary`). Without `agent` it is the project's
 * catalog with New, each skill's files and Remove; with it, the same list
 * with the agent's switches.
 */
export function SkillsPage({ projectId, agent }: { projectId: string; agent?: CapabilityAgent; footer?: ReactNode }) {
  return <CapabilityLibrary projectId={projectId} view="skills" agent={agent} />;
}

/** Tools: every tool an agent can call, project-wide or for one agent. */
export function ToolsPage({ projectId, agent, footer }: { projectId: string; agent?: CapabilityAgent; footer?: ReactNode }) {
  return <CapabilityLibrary projectId={projectId} view="tools" agent={agent} footer={footer} />;
}

/** Extensions: code that runs inside sessions, project-wide or for one agent. */
export function ExtensionsPage({ projectId, agent }: { projectId: string; agent?: CapabilityAgent; footer?: ReactNode }) {
  return <CapabilityLibrary projectId={projectId} view="extensions" agent={agent} />;
}
