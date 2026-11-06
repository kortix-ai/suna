/**
 * Admin: credit codes (`/v1/admin/api/credit-codes`).
 *
 * Staff create a code worth an amount of USD, list every code with its
 * redemption count, and switch a code off. Customers redeem a code through
 * `POST /v1/billing/redeem-code` (billing/routes/credits.ts).
 *
 * `admin/index.ts` mounts this app after its `supabaseAuth` + `requireAdmin`
 * gate. It carries no middleware of its own.
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv } from '../types';
import { auth, errors, json, makeOpenApiApp } from '../openapi';
import { requestClientIp } from '../middleware/client-ip';
import { isUuid } from '../shared/validate';
import {
  CreditCodeError,
  createCreditCode,
  listCreditCodes,
  setCreditCodeActive,
} from '../billing/services/credit-codes';

export const creditCodesApp = makeOpenApiApp<AppEnv>();

const CreditCode = z.object({
  code_id: z.string(),
  code: z.string(),
  amount_usd: z.number(),
  max_redemptions: z.number().nullable(),
  redemption_count: z.number(),
  expires_at: z.string().nullable(),
  active: z.boolean(),
  description: z.string().nullable(),
  created_at: z.string(),
});

const ErrorBody = z.object({ error: z.string(), code: z.string().optional() });

/** The largest single code: $10,000. Anything larger is a contract, not a code. */
const MAX_CODE_USD = 10_000;

async function audit(c: Context<AppEnv>, action: string, codeId: string, after: Record<string, unknown>) {
  try {
    const { recordAuditEvent } = await import('../shared/audit');
    await recordAuditEvent({
      accountId: null,
      actorUserId: c.get('userId') ?? null,
      action,
      resourceType: 'credit_code',
      resourceId: codeId,
      after,
      ip: requestClientIp(c),
      userAgent: c.req.header('user-agent') || null,
    });
  } catch {
    /* audit is best-effort, like every admin route */
  }
}

creditCodesApp.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['admin'],
    summary: 'List credit codes',
    ...auth,
    responses: {
      200: json(z.object({ codes: z.array(CreditCode) }), 'Every credit code, newest first'),
      ...errors(401, 403),
    },
  }),
  async (c) => c.json({ codes: await listCreditCodes() }, 200),
);

creditCodesApp.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['admin'],
    summary: 'Create a credit code',
    ...auth,
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({
              code: z.string(),
              amount_usd: z.number().positive().max(MAX_CODE_USD),
              max_redemptions: z.number().int().positive().nullable().optional(),
              expires_at: z.string().datetime({ offset: true }).nullable().optional(),
              description: z.string().max(500).nullable().optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: json(z.object({ code: CreditCode }), 'The new code'),
      400: json(ErrorBody, 'Bad code'),
      409: json(ErrorBody, 'The code already exists'),
      ...errors(401, 403),
    },
  }),
  async (c) => {
    const body = c.req.valid('json');
    try {
      const code = await createCreditCode({
        code: body.code,
        amountUsd: body.amount_usd,
        maxRedemptions: body.max_redemptions ?? null,
        expiresAt: body.expires_at ?? null,
        description: body.description ?? null,
        createdBy: c.get('userId') ?? null,
      });
      await audit(c, 'admin.credit_code.create', code.code_id, {
        code: code.code,
        amount_usd: code.amount_usd,
        max_redemptions: code.max_redemptions,
        expires_at: code.expires_at,
      });
      return c.json({ code }, 201);
    } catch (e) {
      if (e instanceof CreditCodeError) {
        return c.json({ error: e.message, code: e.code }, e.statusCode === 409 ? 409 : 400);
      }
      throw e;
    }
  },
);

creditCodesApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{id}',
    tags: ['admin'],
    summary: 'Switch a credit code on or off',
    ...auth,
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: z.object({ active: z.boolean() }) } } },
    },
    responses: {
      200: json(z.object({ code: CreditCode }), 'The changed code'),
      404: json(ErrorBody, 'No such code'),
      ...errors(401, 403),
    },
  }),
  async (c) => {
    const id = c.req.param('id');
    const { active } = c.req.valid('json');
    const code = isUuid(id) ? await setCreditCodeActive(id, active) : null;
    if (!code) return c.json({ error: 'No such credit code' }, 404);
    await audit(c, active ? 'admin.credit_code.enable' : 'admin.credit_code.disable', code.code_id, { active });
    return c.json({ code }, 200);
  },
);
