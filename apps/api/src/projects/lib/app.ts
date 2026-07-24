import { makeOpenApiApp } from '../../openapi';
import { type AppEnv } from '../../types';
import {
  OkResponseSchema as ContractOkResponseSchema,
  ProjectSchema as ContractProjectSchema,
  ProjectSessionSchema as ContractProjectSessionSchema,
  SecretSchema as ContractSecretSchema,
  SessionCreateInputSchema as ContractSessionCreateInputSchema,
  SessionCreateAcceptedSchema as ContractSessionCreateAcceptedSchema,
  SessionStartResultSchema as ContractSessionStartResultSchema,
  TriggerSchema as ContractTriggerSchema,
} from '@kortix/api-contract';
import { z } from '@hono/zod-openapi';
import { Hono } from 'hono';

export const projectsApp = makeOpenApiApp<AppEnv>();

export const projectWebhooksApp = new Hono<AppEnv>();

// ─── Reusable OpenAPI schemas (these power the docs, not runtime response
// validation). Core project-domain surfaces come from @kortix/api-contract —
// the shared wire contract — while large/dynamic shapes are still modeled
// loosely with a permissive fallback. ───

export const ProjectSchema = ContractProjectSchema.openapi('Project');

export const SessionSchema = ContractProjectSessionSchema.openapi('Session');

export const SessionStartResultSchema = ContractSessionStartResultSchema.openapi('SessionStartResult');

export const SessionCreateAcceptedSchema = ContractSessionCreateAcceptedSchema.openapi('SessionCreateAccepted');

export const SessionCreateInputSchema = ContractSessionCreateInputSchema.openapi('SessionCreateInput');

export const OkSchema = ContractOkResponseSchema.openapi('Ok');

export const ChangeRequestSchema = z.object({}).passthrough().openapi('ChangeRequest');

export const SecretSchema = ContractSecretSchema.openapi('Secret');

export const TriggerSchema = ContractTriggerSchema.openapi('Trigger');

export const SnapshotSchema = z.object({}).passthrough().openapi('Snapshot');

export const SandboxTemplateSchema = z.object({}).passthrough().openapi('SandboxTemplate');

export const AccessMemberSchema = z.object({}).passthrough().openapi('AccessMember');

export const GroupGrantSchema = z.object({}).passthrough().openapi('GroupGrant');

export const CommitSchema = z.object({}).passthrough().openapi('Commit');

export const AnyObject = z.record(z.string(), z.any());

// ─── PATCH /:projectId/sandbox-provider response (FIX-L) ─────────────────────
// The endpoint returns EITHER the updated project (safe/immediate switch) OR a
// preparation object (the Daytona→Platinum prepare branch), both under HTTP 200.
// An explicit `kind` discriminant makes the union unambiguous; the OpenAPI schema
// is a `oneOf` keyed on it (was a permissive AnyObject that hid the prepare shape).

/** The prepare-branch body: the durable transition the UI polls. Mirrors
 *  `PreparationView` (provider-transition-service.ts) — carries `kind`. */
export const PreparationViewSchema = z
  .object({
    kind: z.literal('preparation'),
    transition_id: z.string().nullable(),
    project_id: z.string(),
    status: z.string(),
    source_provider: z.string().nullable(),
    target_provider: z.string().nullable(),
    active_provider: z.string().nullable(),
    label: z.string(),
    generation: z.number().nullable(),
    snapshot_name: z.string().nullable(),
    external_template_id: z.string().nullable(),
    commit_sha: z.string().nullable(),
    attempts: z.number(),
    last_error: z.string().nullable(),
    error_class: z.string().nullable(),
    requested_at: z.string().nullable(),
    ready_at: z.string().nullable(),
    activated_at: z.string().nullable(),
    immediate: z.boolean(),
  })
  .openapi('PreparationView');

/** The immediate-branch body: the updated project, tagged with `kind:'project'`. */
export const SandboxProviderProjectResultSchema = ContractProjectSchema.extend({
  kind: z.literal('project'),
}).openapi('SandboxProviderProjectResult');

/** Discriminated union → `oneOf` + discriminator on `kind`. */
export const SandboxProviderPatchResultSchema = z
  .discriminatedUnion('kind', [SandboxProviderProjectResultSchema, PreparationViewSchema])
  .openapi('SandboxProviderPatchResult');

// ─── GET /:projectId/sandbox-provider/transition response (FIX-L) ────────────
// PUBLIC projection — status / providers / generation / timestamps / user-safe
// error class only. Never leaks lease_epoch, lease holder, internal error strings,
// image names, or template ids (see toPublicTransitionView).
export const SandboxProviderTransitionViewSchema = z
  .object({
    transition_id: z.string().nullable(),
    project_id: z.string(),
    status: z.string(),
    source_provider: z.string().nullable(),
    target_provider: z.string().nullable(),
    generation: z.number().nullable(),
    label: z.string(),
    error_class: z.string().nullable(),
    requested_at: z.string().nullable(),
    ready_at: z.string().nullable(),
    activated_at: z.string().nullable(),
    immediate: z.boolean(),
  })
  .openapi('SandboxProviderTransitionView');

export const SandboxProviderTransitionStateSchema = z
  .object({
    active_provider: z.string().nullable(),
    latest: SandboxProviderTransitionViewSchema.nullable(),
    history: z.array(SandboxProviderTransitionViewSchema),
  })
  .openapi('SandboxProviderTransitionState');
