/**
 * OpenAPI shapes for the AGI human-request surface. Documentation only — the
 * handlers own validation, exactly as the task, goal, and observation routes do,
 * so the specific messages (`url must be an http(s) link`) survive instead of
 * being flattened into the shared zod-failure envelope.
 */
import { DELIVERY_SURFACES, REQUEST_KINDS, REQUEST_STATUSES } from './wire';
import { z } from '@hono/zod-openapi';

export const AgiRequestSchema = z
  .object({
    request_id: z.string().uuid(),
    workspace_id: z.string().uuid(),
    task_id: z.string().uuid(),
    kind: z.enum(REQUEST_KINDS),
    need: z.string(),
    why: z.string().nullable(),
    /** The minted fill-in link. NEVER a credential — http(s) is enforced. */
    url: z.string().nullable(),
    /** R-28 answer 5's "specific responder". Null means the ask reached nobody. */
    responder_user_id: z.string().uuid().nullable(),
    status: z.enum(REQUEST_STATUSES),
    /** R-12g. Null means recorded but never sent — which liveness reads as a stall. */
    delivered_at: z.string().nullable(),
    delivered_via: z.enum(DELIVERY_SURFACES).nullable(),
    /** Derived: pending AND delivered. The one verdict every caller shares. */
    live: z.boolean(),
    requested_by_session_id: z.string().nullable(),
    origin_fingerprint: z.string().nullable(),
    satisfied_at: z.string().nullable(),
    satisfied_by_user_id: z.string().uuid().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi('AgiRequest');

export const AgiRequestBodySchema = z
  .object({
    kind: z.enum(REQUEST_KINDS),
    need: z.string(),
    why: z.string().nullable(),
    url: z.string().nullable(),
    responder_user_id: z.string().uuid().nullable(),
    session_id: z.string().nullable(),
    origin_fingerprint: z.string().nullable(),
    /** Resolve body. */
    status: z.string(),
    note: z.string().nullable(),
  })
  .partial()
  .openapi('AgiRequestBody');

export const AgiRequestCreateResultSchema = z
  .object({
    request: AgiRequestSchema,
    /** False on a fingerprint dedupe — the same ask already existed, and it was
     *  deliberately NOT re-delivered. */
    created: z.boolean(),
    /** Which surface accepted it, or null when nobody could be reached. */
    delivered_via: z.enum(DELIVERY_SURFACES).nullable(),
  })
  .openapi('AgiRequestCreateResult');

export const AgiRequestResultSchema = z
  .object({ request: AgiRequestSchema })
  .openapi('AgiRequestResult');

export const AgiRequestListSchema = z
  .object({
    requests: z.array(
      AgiRequestSchema.extend({
        /** The blocked work, so an inbox row says what it is holding up without
         *  the caller making one round trip per request. */
        task_title: z.string().nullable(),
      }),
    ),
    truncated: z.boolean(),
  })
  .openapi('AgiRequestList');
