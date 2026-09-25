import { z } from '@hono/zod-openapi';
import { config } from '../config';

/**
 * The OAuth install hand-off shared by Slack and Teams.
 *
 * The provider redirects the browser to the API callback, which carries no
 * Kortix credential. The callback therefore installs nothing: it verifies the
 * signed `state` and forwards the browser to the web completion page. That page
 * posts `{code, state}` with the signed-in user's bearer, and the completion
 * route installs only when the state names that same user and project. An
 * install always lands in the project of the Kortix user who started it.
 */
export type ChatInstallPlatform = 'slack' | 'teams';

export type InstallCompletion =
  | { ok: true; redirectUrl: string }
  | { ok: false; status: 400 | 403 | 503; error: string; code?: string };

export const INSTALL_STATE_INVALID = 'CHANNEL_INSTALL_STATE_INVALID';
export const INSTALL_STATE_MISMATCH = 'CHANNEL_INSTALL_STATE_MISMATCH';

export function frontendBase(): string {
  return (config.FRONTEND_URL || 'https://kortix.com').replace(/\/+$/, '');
}

/** Where the callback sends the browser to finish the install as a signed-in user. */
export function installHandoffUrl(
  platform: ChatInstallPlatform,
  input: { projectId: string; code: string; state: string },
): string {
  const params = new URLSearchParams({ project: input.projectId, code: input.code, state: input.state });
  return `${frontendBase()}/channels/install/${platform}?${params.toString()}`;
}

export type InstallRefusal = Extract<InstallCompletion, { ok: false }>;

/**
 * The verified state when it names the caller and the caller's project, else
 * the refusal to send: 400 when the state did not verify, 403 when it names
 * another project or another Kortix user.
 */
export function stateForCaller<T extends { projectId: string; userId: string }>(
  state: T | null,
  caller: { projectId: string; userId: string },
): { ok: true; state: T } | InstallRefusal {
  if (!state) {
    return {
      ok: false,
      status: 400,
      error: 'This install link is invalid or has expired. Start the install again.',
      code: INSTALL_STATE_INVALID,
    };
  }
  if (state.projectId !== caller.projectId || state.userId !== caller.userId) {
    return {
      ok: false,
      status: 403,
      error: 'This install was started by another Kortix account or for another project. Start it again from the project.',
      code: INSTALL_STATE_MISMATCH,
    };
  }
  return { ok: true, state };
}

/** The body the web completion page posts: the provider's code and the signed state. */
export const InstallCompletionBody = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});
