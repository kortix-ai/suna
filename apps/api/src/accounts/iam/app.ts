// IAM V2 router instance + shared OpenAPI schemas.
//
// This is the LEAF module of the accounts/iam/ split: it imports only the
// openapi foundation, db types, and the IAM engine type used by the shared
// schemas. Route modules import `iamRouter` (and these schemas) from here
// and register their routes via side effect. The barrel at ../iam.ts wires
// them all in the original order.

import { z } from '@hono/zod-openapi';
import { makeOpenApiApp } from '../../openapi';
import type { AppEnv } from '../../types';
import type { ResourceType } from '../../iam';

export const iamRouter = makeOpenApiApp<AppEnv>();

// ─── Reusable OpenAPI schemas ────────────────────────────────────────────────
// Permissive shapes: these power the docs, not runtime validation of responses.

export const AccountIdParam = z.object({ accountId: z.string() });
export const GroupParams = z.object({ accountId: z.string(), groupId: z.string() });
export const MemberParams = z.object({ accountId: z.string(), userId: z.string() });

export const GroupSchema = z
  .object({
    group_id: z.string(),
    name: z.string(),
    description: z.string().nullable().optional(),
    source: z.string().optional(),
    external_id: z.string().nullable().optional(),
    member_count: z.number().optional(),
    project_count: z.number().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
  })
  .openapi('IamGroup');

export const GroupMemberSchema = z
  .object({
    user_id: z.string(),
    added_at: z.string(),
    added_by: z.string().nullable(),
  })
  .openapi('IamGroupMember');

export const ProjectGrantSchema = z
  .object({
    project_id: z.string(),
    project_name: z.string(),
    role: z.string(),
    granted_by: z.string().nullable(),
    created_at: z.string(),
    expires_at: z.string().nullable(),
  })
  .openapi('IamProjectGrant');

export const ProjectAccessSchema = z
  .object({
    project_id: z.string(),
    project_name: z.string(),
    role: z.string(),
    sources: z.array(z.string()),
  })
  .openapi('IamProjectAccess');

export const EffectiveResultSchema = z
  .object({
    allowed: z.boolean(),
    reason: z.string().nullable(),
    action: z.string(),
    resource_type: z.string().nullable().optional(),
  })
  .openapi('IamEffectiveResult');

export const EffectiveBatchResultSchema = z
  .object({
    action: z.string(),
    resource_type: z.string().nullable().optional(),
    resource_id: z.string().nullable(),
    allowed: z.boolean(),
    reason: z.string().nullable(),
  })
  .openapi('IamEffectiveBatchResult');

export const ScimTokenSchema = z
  .object({
    token_id: z.string(),
    name: z.string(),
    public_prefix: z.string(),
    status: z.string().optional(),
    secret: z.string().optional(),
    created_at: z.string(),
    last_used_at: z.string().nullable().optional(),
    expires_at: z.string().nullable().optional(),
    revoked_at: z.string().nullable().optional(),
    scim_base_url: z.string().optional(),
  })
  .openapi('IamScimToken');

export const SsoProviderSchema = z
  .object({
    sso_provider_id: z.string(),
    supabase_sso_provider_id: z.string(),
    name: z.string(),
    primary_domain: z.string(),
    group_claim_name: z.string().nullable().optional(),
    auto_create_members: z.boolean().optional(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi('IamSsoProvider');

export const SsoMappingSchema = z
  .object({
    mapping_id: z.string(),
    claim_value: z.string(),
    group_id: z.string(),
    group_name: z.string().nullable().optional(),
    created_at: z.string(),
  })
  .openapi('IamSsoMapping');

export const ServiceAccountSchema = z
  .object({
    service_account_id: z.string(),
    name: z.string(),
    description: z.string().nullable().optional(),
    public_prefix: z.string(),
    status: z.string().optional(),
    secret: z.string().optional(),
    last_used_at: z.string().nullable().optional(),
    expires_at: z.string().nullable().optional(),
    created_at: z.string(),
    disabled_at: z.string().nullable().optional(),
  })
  .openapi('IamServiceAccount');

const VALID_RESOURCE_TYPES: readonly ResourceType[] = [
  'account',
  'project',
  'sandbox',
  'trigger',
  'channel',
  'member',
  'group',
];

export function isResourceType(value: unknown): value is ResourceType {
  return typeof value === 'string' && (VALID_RESOURCE_TYPES as readonly string[]).includes(value);
}
