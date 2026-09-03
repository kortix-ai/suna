import { isMetaAgentName } from '@kortix/shared';

import { resolveAgentGrant } from '../../projects/agents';
import type { GitBackedProject } from '../../projects/git';
import { platformMetaAgentGrant } from '../../projects/lib/platform-meta-agent';
import { createAccountToken } from '../../repositories/account-tokens';
import { ensureAgentServiceAccount } from '../../repositories/service-accounts';

export type SessionRuntimeKind = 'worker' | 'environment';

/** Mint one bearer for one physical runtime. The two Pi boxes never share it. */
export async function mintSessionRuntimeToken(opts: {
  accountId: string;
  userId: string;
  projectId: string;
  sessionId: string;
  runtimeKind: SessionRuntimeKind;
  runtimeId: string;
  agentName: string;
  gitProject: GitBackedProject;
}): Promise<{ tokenId: string; secretKey: string }> {
  const platformMetaAgent = isMetaAgentName(opts.agentName);
  const [agentGrant, serviceAccountId] = platformMetaAgent
    ? [platformMetaAgentGrant(), null]
    : await Promise.all([
        resolveAgentGrant(opts.agentName, opts.gitProject),
        ensureAgentServiceAccount({
          accountId: opts.accountId,
          projectId: opts.projectId,
          agentName: opts.agentName,
        }).catch((err) => {
          console.warn(
            `[session-runtime-token] failed to ensure agent service account for ${opts.projectId}:`,
            err,
          );
          return null;
        }),
      ]);

  const token = await createAccountToken({
    accountId: opts.accountId,
    userId: opts.userId,
    projectId: opts.projectId,
    sessionId: opts.sessionId,
    runtimeKind: opts.runtimeKind,
    runtimeId: opts.runtimeId,
    name: `${opts.runtimeKind === 'worker' ? 'Worker' : 'Environment'} ${opts.runtimeId.slice(0, 8)}`,
    agentGrant,
    serviceAccountId,
  });
  return { tokenId: token.tokenId, secretKey: token.secretKey };
}
