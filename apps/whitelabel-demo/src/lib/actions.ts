'use server';

import { redirect } from 'next/navigation';
import {
  authenticateUser,
  clearBrowserSession,
  createBrowserSession,
  createUser,
  normalizeEmail,
  normalizePassword,
  requireCurrentUser,
} from './auth';
import { createDemoSession, ensureWorkspaceForUser, sendSessionPrompt } from './kortix';
import { findRunForUser } from './store';

function queryError(message: string) {
  return `?error=${encodeURIComponent(message)}`;
}

export async function loginAction(formData: FormData) {
  const email = normalizeEmail(formData.get('email'));
  const password = normalizePassword(formData.get('password'));
  const user = await authenticateUser(email, password);
  if (!user) redirect(`/login${queryError('Email or password is incorrect.')}`);
  await createBrowserSession(user.id);
  redirect('/');
}

export async function registerAction(formData: FormData) {
  const email = normalizeEmail(formData.get('email'));
  const password = normalizePassword(formData.get('password'));
  try {
    const user = await createUser(email, password);
    await createBrowserSession(user.id);
  } catch (error) {
    redirect(`/register${queryError(error instanceof Error ? error.message : 'Could not create the demo user.')}`);
  }
  redirect('/');
}

export async function logoutAction() {
  await clearBrowserSession();
  redirect('/login');
}

export async function createSessionAction(formData: FormData) {
  const user = await requireCurrentUser();
  const prompt = String(formData.get('prompt') ?? '').trim() || 'Inspect this workspace and suggest the next useful change.';
  const mode = String(formData.get('mode') ?? '').trim() || 'Build';
  let sessionId: string;
  try {
    const projectId = await ensureWorkspaceForUser(user);
    const session = await createDemoSession({ user, projectId, prompt, mode });
    sessionId = session.id;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not start the session.';
    redirect(`/${queryError(message)}`);
  }
  redirect(`/sessions/${sessionId}`);
}

/**
 * Sends a follow-up message to the agent — a real OpenCode `session.prompt`
 * through the Kortix backend, exactly like the core app. The session stream
 * then picks up and streams the agent's response back. No local simulation.
 */
export async function continueSessionAction(input: {
  sessionId: string;
  prompt: string;
}): Promise<{ ok: boolean; error?: string }> {
  const user = await requireCurrentUser();
  const sessionId = input.sessionId?.trim();
  const prompt = input.prompt?.trim();
  if (!sessionId || !prompt) return { ok: false, error: 'Enter a message to send.' };

  const run = await findRunForUser(user.id, sessionId);
  if (!run) return { ok: false, error: 'This session is no longer available.' };

  try {
    await sendSessionPrompt({ projectId: run.projectId, sessionId, text: prompt });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not reach the agent.',
    };
  }
}
