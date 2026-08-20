import { verifyStandardWebhook } from '../../lib/webhooks/standard-webhooks';

/**
 * AgentMail signs with Standard Webhooks (Svix). The comparison itself lives in
 * lib/webhooks/standard-webhooks.ts, shared with the Supabase auth send-email
 * hook; this wrapper only keeps AgentMail's parameter names.
 */
export function verifyAgentMailSignature(input: {
  rawBody: string;
  secret: string;
  svixId: string;
  svixTimestamp: string;
  svixSignature: string;
}): boolean {
  return verifyStandardWebhook({
    rawBody: input.rawBody,
    secret: input.secret,
    headers: {
      id: input.svixId,
      timestamp: input.svixTimestamp,
      signature: input.svixSignature,
    },
  });
}
