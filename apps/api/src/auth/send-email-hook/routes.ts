// POST /v1/webhooks/auth/send-email — Supabase Auth "send email" hook.
//
// GoTrue calls this instead of sending auth mail itself, so magic links,
// signup confirmations, password resets and email changes go out through the
// same provider chain, sender identity and templates as every other Kortix
// email. Configure once (EMAIL_URL) and both halves of the system work.
//
// The route is unauthenticated by design and gated on a Standard Webhooks HMAC
// signature (AUTH_EMAIL_HOOK_SECRET). It deliberately lives under /v1/webhooks
// rather than /v1/auth, which requires a Supabase session.
//
// It answers only after the send resolves. Supabase bounds hook execution, so a
// relay that is slow enough to blow that budget surfaces to the user as a
// failed sign-in — which is the honest signal. SMTP connections are pooled, so
// only the first send after a cold start pays the TLS handshake.
import { createRoute, z } from '@hono/zod-openapi';

import { config } from '../../config';
import { sendEmail } from '../../lib/email/transport';
import {
  readStandardWebhookHeaders,
  verifyStandardWebhook,
} from '../../lib/webhooks/standard-webhooks';
import { errors, json } from '../../openapi';
import { authEmailHookApp } from './app';
import { parseSendEmailHookPayload, type SendEmailHookPayload } from './payload';
import { renderAuthEmail } from './templates';

/** Public Supabase origin for the verification link — see buildVerifyUrl(). */
export function authVerifyBaseUrl(): string {
  return (config.SUPABASE_PUBLIC_URL || config.SUPABASE_URL || '').trim();
}

authEmailHookApp.openapi(
  createRoute({
    method: 'post',
    path: '/send-email',
    tags: ['auth'],
    summary: 'Supabase Auth send-email hook (Standard Webhooks signature verified)',
    request: {
      body: { content: { 'application/json': { schema: z.any() } } },
    },
    responses: {
      200: json(z.object({}), 'Email sent'),
      ...errors(400, 401, 500, 503),
    },
  }),
  async (c: any) => {
    const secret = (config.AUTH_EMAIL_HOOK_SECRET || '').trim();
    if (!secret) {
      return c.json({ error: 'Auth email hook is not configured' }, 503);
    }

    const rawBody = await c.req.text();
    const verified = verifyStandardWebhook({
      rawBody,
      secret,
      headers: readStandardWebhookHeaders((name) => c.req.header(name)),
    });
    if (!verified) {
      return c.json({ error: 'Invalid signature' }, 401);
    }

    let payload: SendEmailHookPayload;
    try {
      payload = JSON.parse(rawBody) as SendEmailHookPayload;
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const parsed = parseSendEmailHookPayload(payload, authVerifyBaseUrl());
    if (!parsed.ok) {
      return c.json({ error: parsed.reason }, 400);
    }

    const content = renderAuthEmail({
      actionType: parsed.email.actionType,
      actionUrl: parsed.email.actionUrl,
      token: parsed.email.token,
    });

    const result = await sendEmail({
      to: [parsed.email.recipient],
      subject: content.subject,
      html: content.html,
      text: content.text,
      category: content.category,
    });

    if (result.ok) return c.json({}, 200);

    // Surface the failure to GoTrue so the user is told the mail did not go out,
    // rather than being left waiting for a link that will never arrive.
    if ('skipped' in result && result.skipped) {
      console.error('[auth-email-hook] no email provider configured — set EMAIL_URL');
      return c.json({ error: 'Email delivery is not configured' }, 503);
    }
    console.error(
      `[auth-email-hook] ${parsed.email.actionType} send failed via ${result.provider}: ${result.error}`,
    );
    return c.json({ error: 'Email delivery failed' }, 500);
  },
);
