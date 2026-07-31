import { randomBytes } from 'node:crypto';
import { resolveTemplateBySlug } from '../../snapshots/templates';
import { isRepoFileNotFoundError, readRepoFile } from '../git';
import {
  createRemoteSessionBranch,
  deleteRemoteSessionBranch,
} from '../git/branches';
import type { GitBackedProject } from '../git';
import { parseAgentMarkdown } from './agent-markdown';
import type { BehaviorFileState } from './agent-config-v2';
import { withProjectGitAuth } from './git';

export type AgentMarkdownRead =
  | { state: 'exists'; frontmatter: Record<string, unknown>; body: string }
  | { state: 'missing'; frontmatter: Record<string, unknown>; body: string }
  | { state: 'read_error'; frontmatter: Record<string, unknown>; body: string; error: string };

export class AgentBranchNameCollisionError extends Error {
  constructor(readonly agentName: string) {
    super(`Could not allocate a unique branch name for agent "${agentName}"`);
    this.name = 'AgentBranchNameCollisionError';
  }
}

export async function readAgentMarkdown(
  loadedRow: Parameters<typeof withProjectGitAuth>[0],
  branch: string,
  mdPath: string,
): Promise<AgentMarkdownRead> {
  try {
    const gitProject = await withProjectGitAuth(loadedRow);
    const content = await readRepoFile(gitProject, mdPath, branch);
    return { state: 'exists', ...parseAgentMarkdown(content) };
  } catch (error) {
    if (isRepoFileNotFoundError(error)) {
      return { state: 'missing', frontmatter: {}, body: '' };
    }
    return {
      state: 'read_error',
      frontmatter: {},
      body: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function jsonConfigError(
  c: any,
  result: { status: number; code: string; error: string; issues?: unknown[] },
) {
  return c.json(
    {
      error: result.error,
      code: result.code,
      ...(result.issues ? { issues: result.issues } : {}),
    },
    result.status as any,
  );
}

export function changeRequestCreateFailedBody(error: unknown) {
  return {
    error: `Failed to create change request: ${
      error instanceof Error ? error.message : String(error)
    }`,
    code: 'change_request_create_failed',
  };
}

export function behaviorState(read: AgentMarkdownRead): BehaviorFileState {
  return read.state;
}

function agentBranchName(kind: 'create' | 'repair', agentName: string): string {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  return `kortix/agents/${kind}/${agentName}-${stamp}-${randomBytes(4).toString('hex')}`;
}

export async function createAgentChangeBranch(
  project: GitBackedProject,
  kind: 'create' | 'repair',
  agentName: string,
  baseRef: string,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const branch = agentBranchName(kind, agentName);
    try {
      await createRemoteSessionBranch(project, branch, baseRef);
      return branch;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/already exists|reference already exists/i.test(message)) break;
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  if (/already exists|reference already exists/i.test(message)) {
    throw new AgentBranchNameCollisionError(agentName);
  }
  throw lastError;
}

export async function cleanupAgentChangeBranch(
  project: GitBackedProject,
  branch: string,
): Promise<void> {
  await deleteRemoteSessionBranch(project, branch).catch(() => undefined);
}

export async function assertSandboxTemplate(
  loadedRow: Parameters<typeof withProjectGitAuth>[0],
  agentName: string,
  block: { sandbox?: string },
): Promise<{ ok: true } | { ok: false; body: Record<string, unknown> }> {
  if (!block.sandbox) return { ok: true };
  try {
    await resolveTemplateBySlug(await withProjectGitAuth(loadedRow), block.sandbox);
    return { ok: true };
  } catch {
    return {
      ok: false,
      body: {
        error: `Unknown sandbox template "${block.sandbox}"`,
        code: 'invalid_config',
        issues: [
          {
            path: `agents.${agentName}.sandbox`,
            message: 'must name an available project template or "default".',
            severity: 'error',
          },
        ],
      },
    };
  }
}
