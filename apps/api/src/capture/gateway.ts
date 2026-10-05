/**
 * Model calls of Capture go through the standalone LLM gateway with a
 * short-lived account token of the person the work is for, billed to the
 * account and revoked when the work ends.
 */
import { standaloneGatewayUrl } from '../llm-gateway/standalone-url';
import { createAccountToken, revokeAccountToken } from '../repositories/account-tokens';

const TOKEN_NAME = 'internal-capture-processing';

export async function withCaptureGateway<T>(
  owner: { accountId: string; userId: string },
  work: (gateway: { url: string; authorization: string }) => Promise<T>,
): Promise<T> {
  const url = standaloneGatewayUrl();
  if (!url) throw new Error('the standalone LLM gateway is not configured');
  // 1 h at most, revoked in `finally`.
  const token = await createAccountToken({ ...owner, name: TOKEN_NAME, expiresAt: new Date(Date.now() + 60 * 60_000) });
  try {
    return await work({ url, authorization: `Bearer ${token.secretKey}` });
  } finally {
    await revokeAccountToken(token.tokenId, owner.accountId).catch(() => {});
  }
}
