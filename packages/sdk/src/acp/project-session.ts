import { platformConfig } from '../platform/config';
import { createAcpClient } from './client';
import type { AcpContentBlock } from './types';

export function projectAcpEndpoint(projectId: string, sessionId: string): string {
  return `${platformConfig().backendUrl.replace(/\/$/, '')}/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/acp`;
}

/** Imperative companion to useAcpSession for host actions outside a chat composer. */
export async function promptProjectAcpSession(input: {
  projectId: string;
  sessionId: string;
  runtimeSessionId: string;
  prompt: AcpContentBlock[];
}): Promise<{ stopReason: string }> {
  return createAcpClient({ endpoint: projectAcpEndpoint(input.projectId, input.sessionId) })
    .prompt(input.runtimeSessionId, input.prompt);
}
