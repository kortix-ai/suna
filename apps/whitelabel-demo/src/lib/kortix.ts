import 'server-only';

import { createKortix, type Kortix, type SessionHandle } from '@kortix/sdk';
import { getKortixApiUrl, requireKortixToken } from './config';
import { buildSessionPrompt } from './session-prompt';
import { mutateStore, rememberRun, type DemoUser } from './store';

/**
 * The white-label API seam. Everything that talks to Kortix goes through the
 * official `@kortix/sdk` — no raw HTTP, no OpenCode semantics. Swap the base URL
 * + token here (and the brand config) and this app re-points at any Kortix deployment.
 */
export function getKortix(): Kortix {
  return createKortix({ baseUrl: getKortixApiUrl(), token: requireKortixToken() });
}

export { buildSessionPrompt } from './session-prompt';

export async function ensureWorkspaceForUser(user: DemoUser): Promise<string> {
  if (user.kortixProjectId) return user.kortixProjectId;
  const project = await getKortix().projects.provision({
    name: `Kortix Demo Workspace ${safeProjectSuffix(user)}`,
    seedStarter: true,
  });
  await mutateStore((database) => {
    const current = database.users.find((candidate) => candidate.id === user.id);
    if (current) {
      current.kortixProjectId = project.project_id;
      current.updatedAt = new Date().toISOString();
    }
  });
  return project.project_id;
}

export async function createDemoSession(input: {
  user: DemoUser;
  projectId: string;
  prompt: string;
  mode?: string;
}): Promise<SessionHandle> {
  const title = titleFromPrompt(input.prompt);
  const session = await getKortix().sessions.create({
    projectId: input.projectId,
    prompt: buildSessionPrompt({ prompt: input.prompt, mode: input.mode }),
    agent: 'default',
    name: title,
    metadata: {
      product: 'kortix-whitelabel-demo',
      surface: 'apps/whitelabel-demo',
      run_type: 'generic_session',
      mode: input.mode ?? 'Build',
      prompt: input.prompt,
    },
  });
  await rememberRun({
    userId: input.user.id,
    projectId: input.projectId,
    sessionId: session.id,
    title,
    prompt: input.prompt,
    mode: input.mode ?? 'Build',
  });
  return session;
}

export async function sendSessionPrompt(input: {
  projectId: string;
  sessionId: string;
  text: string;
}): Promise<void> {
  const session = await getKortix().sessions.get({
    projectId: input.projectId,
    sessionId: input.sessionId,
  });
  await session.send(input.text);
}

function safeProjectSuffix(user: DemoUser) {
  const local = user.email.split('@')[0] ?? 'demo';
  const cleaned = local.replace(/[^a-zA-Z0-9._ -]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (cleaned || user.id.slice(0, 8)).slice(0, 36);
}

function titleFromPrompt(prompt: string) {
  const firstLine = prompt.trim().split('\n')[0] ?? '';
  const compact = firstLine.replace(/\s+/g, ' ').trim();
  if (!compact) return 'New session';
  return compact.length > 52 ? `${compact.slice(0, 49)}...` : compact;
}
