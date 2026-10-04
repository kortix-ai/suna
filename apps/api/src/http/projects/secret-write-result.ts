/**
 * The secret write response: the secret, plus what the sandbox fan-out did
 * (`delivery_sync`, see `SecretDeliverySync` in services/secrets/secret-writes.ts).
 */
import { z } from '@hono/zod-openapi';
import { SecretSchema as ContractSecretSchema } from '@kortix/api-contract';

const SecretDeliverySyncSchema = z
  .object({
    ok: z.boolean(),
    targeted: z.number(),
    synced: z.number(),
    failed: z.number(),
    failures: z.array(
      z.object({
        session_id: z.string(),
        sandbox_id: z.string().nullable(),
        reason: z.string(),
      }),
    ),
  })
  .nullable()
  .optional();

export const SecretWriteResultSchema = ContractSecretSchema.extend({
  delivery_sync: SecretDeliverySyncSchema,
}).openapi('SecretWriteResult');

