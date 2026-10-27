import { verifyStandardWebhook } from '../../lib/webhooks/standard-webhooks';

/**
 * Resend signs webhooks with Svix (Standard Webhooks). The comparison itself
 * lives in lib/webhooks/standard-webhooks.ts, shared with the Supabase auth
 * send-email hook.
 */
export function verifyEmailWebhookSignature(input: {
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
