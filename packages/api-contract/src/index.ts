/**
 * @kortix/api-contract — the shared wire contract for the Kortix platform API.
 *
 * Zod schemas + inferred TS types describing EXACTLY what apps/api serializes
 * onto the wire today. The API serializers
 * (apps/api/src/projects/lib/serializers.ts et al) are the behavioral source
 * of truth; these schemas are purely descriptive — nothing here validates
 * requests or reshapes responses.
 *
 * The contract is enforced two ways:
 *   1. compile time — serializer return types in apps/api are annotated with
 *      the inferred types below, so any added/renamed/retyped field fails
 *      typecheck (object-literal excess-property checks catch additions);
 *   2. runtime — apps/api's unit suite parses real serializer output against
 *      these schemas (see
 *      apps/api/src/__tests__/unit-api-contract-serializers.test.ts).
 */
import { z } from 'zod';

/** Loose JSON object — jsonb metadata/config columns surfaced as-is. */
export const JsonObjectSchema = z.record(z.string(), z.unknown());
export type JsonObject = z.infer<typeof JsonObjectSchema>;

/**
 * Standard error envelope. Matches the platform-wide shape
 * (`{ error, message, code, status }`) — permissive because handlers attach
 * route-specific extras (e.g. `balance` on 402, `issues` on validation 400).
 */
export const ErrorEnvelopeSchema = z.object({
  error: z.union([z.boolean(), z.string()]).optional(),
  message: z.string().optional(),
  code: z.string().optional(),
  status: z.number().optional(),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

/** Bare success acknowledgement returned by delete/detach-style routes. */
export const OkResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponseSchema>;

/**
 * Effective on/off map for every experimental feature. Keys mirror the
 * registry in apps/api/src/experimental/features.ts, which imports
 * `ExperimentalFeatureKey` from here — adding a feature there without
 * updating this map fails typecheck.
 */
export const ExperimentalFeatureMapSchema = z.object({
  apps: z.boolean(),
  agent_tunnel: z.boolean(),
  marketplace: z.boolean(),
  agentmail_email: z.boolean(),
  meet: z.boolean(),
  llm_gateway: z.boolean(),
  review_center: z.boolean(),
});
export type ExperimentalFeatureMap = z.infer<typeof ExperimentalFeatureMapSchema>;

export const ExperimentalFeatureKeySchema = ExperimentalFeatureMapSchema.keyof();
export type ExperimentalFeatureKey = z.infer<typeof ExperimentalFeatureKeySchema>;
export const EXPERIMENTAL_FEATURE_KEYS = ExperimentalFeatureKeySchema.options;

/** One catalog entry of the self-describing experimental-features UI list. */
export const ExperimentalFeatureViewSchema = z.object({
  key: ExperimentalFeatureKeySchema,
  name: z.string(),
  description: z.string(),
  stability: z.enum(['experimental', 'beta']),
  available: z.boolean(),
  enabled: z.boolean(),
  overridden: z.boolean(),
});
export type ExperimentalFeatureView = z.infer<typeof ExperimentalFeatureViewSchema>;

/** Assignable project roles (`user`/`viewer` are deprecated and no longer emitted). */
export const PROJECT_ROLES = ['manager', 'editor', 'member'] as const;
export const ProjectRoleSchema = z.enum(PROJECT_ROLES);
export type ProjectRole = z.infer<typeof ProjectRoleSchema>;

/** Every provider that can appear on session/sandbox rows. 'daytona' is the
 *  managed cloud backend's identity (default / first-class); 'managed' is kept as
 *  an accepted value only because the DB sandbox_provider enum still carries it
 *  (from the reverted daytona→managed rename) — a DB-derived provider can read
 *  back 'managed', and the dual-accept guards resolve it to the Daytona adapter.
 *  Nothing DEFAULTS to or normalizes toward 'managed'. */
export const SANDBOX_PROVIDERS = [
  'daytona',
  'managed',
  'local_docker',
  'justavps',
  'platinum',
] as const;
export const SandboxProviderSchema = z.enum(SANDBOX_PROVIDERS);
export type SandboxProvider = z.infer<typeof SandboxProviderSchema>;

/**
 * The dashboard's three sharing options, as emitted on sessions
 * (`visibilityToIntent`) and secrets (`scopeToIntent`).
 */
export const SharingIntentSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('project') }),
  z.object({ mode: z.literal('private'), ownerId: z.string() }),
  z.object({
    mode: z.literal('members'),
    memberIds: z.array(z.string()).readonly().optional(),
    groupIds: z.array(z.string()).readonly().optional(),
  }),
]);
export type SharingIntent = z.infer<typeof SharingIntentSchema>;

/** A project as serialized by `serializeProject`. */
export const ProjectSchema = z.object({
  project_id: z.string(),
  account_id: z.string(),
  name: z.string(),
  repo_url: z.string(),
  /** Universal client-facing git origin (proxy URL when enabled, else repo_url). */
  git_origin_url: z.string(),
  default_branch: z.string(),
  manifest_path: z.string(),
  status: z.enum(['active', 'archived']),
  metadata: JsonObjectSchema,
  last_opened_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  /** Explicit project_members role, or null when access is inherited. */
  project_role: ProjectRoleSchema.nullable(),
  /** UI label for the caller's effective role (not an auth decision). */
  effective_project_role: ProjectRoleSchema.nullable(),
  dashboard_url: z.string(),
  experimental: ExperimentalFeatureMapSchema,
  experimental_features: z.array(ExperimentalFeatureViewSchema),
  /** Back-compat alias for `experimental.apps`. */
  apps_enabled: z.boolean(),
  /** Per-project provider pin, surfaced only while still usable. */
  default_sandbox_provider: z.string().nullable(),
  available_sandbox_providers: z.array(SandboxProviderSchema),
});
export type Project = z.infer<typeof ProjectSchema>;

export const SESSION_STATUSES = [
  'queued',
  'branching',
  'provisioning',
  'running',
  'stopped',
  'failed',
  'completed',
] as const;
export const SessionStatusSchema = z.enum(SESSION_STATUSES);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SESSION_VISIBILITIES = ['private', 'project', 'restricted'] as const;
export const SessionVisibilitySchema = z.enum(SESSION_VISIBILITIES);
export type SessionVisibility = z.infer<typeof SessionVisibilitySchema>;

/**
 * Non-secret, wrapper-supplied context attached durably to one Kortix session.
 * This is not an environment-variable map: the server serializes the whole
 * object into one server-owned `KORTIX_SESSION_CONTEXT` JSON envelope.
 */
export const SESSION_RUNTIME_CONTEXT_MAX_KEYS = 64;
export const SESSION_RUNTIME_CONTEXT_MAX_BYTES = 16 * 1024;
export const SESSION_RUNTIME_CONTEXT_KEY_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const SESSION_RUNTIME_CONTEXT_SENSITIVE_KEY_PATTERN =
  /(^|[._-])(token|secret|password|credential|api[_-]?key|private[_-]?key|authorization|cookie)([._-]|$)/;

export const SessionRuntimeContextScalarSchema = z.union([
  z.string().max(4096),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export type SessionRuntimeContextScalar = z.infer<typeof SessionRuntimeContextScalarSchema>;

export const SessionRuntimeContextSchema = z
  .record(
    z
      .string()
      .regex(
        SESSION_RUNTIME_CONTEXT_KEY_PATTERN,
        'runtime_context keys must start with a lower-case letter and contain only lower-case letters, numbers, dots, dashes, or underscores (max 64 characters)',
      )
      .refine(
        (key) => !SESSION_RUNTIME_CONTEXT_SENSITIVE_KEY_PATTERN.test(key),
        'runtime_context is non-secret and cannot contain credential-like keys',
      ),
    SessionRuntimeContextScalarSchema,
  )
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > SESSION_RUNTIME_CONTEXT_MAX_KEYS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `runtime_context may contain at most ${SESSION_RUNTIME_CONTEXT_MAX_KEYS} entries`,
      });
    }
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (bytes > SESSION_RUNTIME_CONTEXT_MAX_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `runtime_context must be at most ${SESSION_RUNTIME_CONTEXT_MAX_BYTES} UTF-8 bytes`,
      });
    }
  });
export type SessionRuntimeContext = z.infer<typeof SessionRuntimeContextSchema>;

export const SESSION_CONNECTOR_BINDINGS_MAX_KEYS = 64;
export const SessionConnectorBindingSchema = z
  .object({
    profile_id: z.string().uuid(),
  })
  .strict();
export type SessionConnectorBinding = z.infer<typeof SessionConnectorBindingSchema>;

export const SessionConnectorBindingsSchema = z
  .record(
    z
      .string()
      .regex(
        /^[a-z][a-z0-9_-]{0,127}$/,
        'connector binding aliases must be lower-case connector slugs',
      ),
    SessionConnectorBindingSchema,
  )
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > SESSION_CONNECTOR_BINDINGS_MAX_KEYS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `connector_bindings may contain at most ${SESSION_CONNECTOR_BINDINGS_MAX_KEYS} entries`,
      });
    }
  });
export type SessionConnectorBindings = z.infer<typeof SessionConnectorBindingsSchema>;

export const ConnectionProfileOwnerTypeSchema = z.enum(['agent', 'member', 'subject', 'external']);
export const ConnectionProfileStatusSchema = z.enum(['active', 'revoked', 'error']);
export const ConnectionProfileMetadataSchema = z
  .record(
    z
      .string()
      .regex(/^[a-z][a-z0-9_.-]{0,63}$/)
      .refine(
        (key) =>
          !/(^|[._-])(token|secret|password|credential|api[_-]?key|private[_-]?key|authorization|cookie)([._-]|$)/.test(
            key,
          ),
        'connection profile metadata is non-secret',
      ),
    SessionRuntimeContextScalarSchema,
  )
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > 64) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'metadata may contain at most 64 entries',
      });
    }
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 16 * 1024) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'metadata must be at most 16384 UTF-8 bytes',
      });
    }
  });
export const ConnectionProfileSchema = z.object({
  profile_id: z.string().uuid(),
  connector_alias: z.string(),
  owner_type: z.enum(['project', 'agent', 'member', 'subject', 'external']),
  owner_id: z.string().nullable(),
  label: z.string(),
  status: ConnectionProfileStatusSchema,
  is_default: z.boolean(),
  metadata: ConnectionProfileMetadataSchema,
});
export type ConnectionProfile = z.infer<typeof ConnectionProfileSchema>;

export const ReconcileConnectionProfileInputSchema = z
  .object({
    connector_alias: z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/),
    owner_type: ConnectionProfileOwnerTypeSchema,
    owner_id: z.string().trim().min(1).max(512),
    label: z.string().trim().min(1).max(255),
    metadata: ConnectionProfileMetadataSchema.optional(),
  })
  .strict();
export type ReconcileConnectionProfileInput = z.infer<typeof ReconcileConnectionProfileInputSchema>;

export const UpdateConnectionProfileCredentialInputSchema = z
  .object({
    value: z.string().min(1).max(65536),
    kind: z.enum(['secret', 'connection']).optional(),
  })
  .strict();
export type UpdateConnectionProfileCredentialInput = z.infer<
  typeof UpdateConnectionProfileCredentialInputSchema
>;

/** Authoritative public body for POST /v1/projects/:projectId/sessions. */
export const SessionCreateInputSchema = z
  .object({
    base_ref: z.string().min(1).optional(),
    agent_name: z.string().min(1).optional(),
    sandbox_slug: z.string().min(1).optional(),
    initial_prompt: z.string().optional(),
    opencode_model: z.string().min(1).optional(),
    name: z.string().optional(),
    session_id: z
      .string()
      .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      'session_id must be an RFC 4122 v4 UUID',
      )
      .optional(),
    provider: SandboxProviderSchema.optional(),
    branch_already_created: z.boolean().optional(),
    metadata: JsonObjectSchema.optional(),
    runtime_context: SessionRuntimeContextSchema.optional(),
    connector_bindings: SessionConnectorBindingsSchema.optional(),
    // Deprecated camelCase compatibility accepted by the pre-contract route.
    // New SDK/API consumers use the snake_case fields above.
    baseRef: z.string().min(1).optional(),
    agentName: z.string().min(1).optional(),
    sandboxSlug: z.string().min(1).optional(),
    initialPrompt: z.string().optional(),
    opencodeModel: z.string().min(1).optional(),
    sessionId: z
      .string()
      .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      'sessionId must be an RFC 4122 v4 UUID',
      )
      .optional(),
    branchAlreadyCreated: z.boolean().optional(),
  })
  .strict();
export type SessionCreateInput = z.infer<typeof SessionCreateInputSchema>;

/** A project session as serialized by `serializeSession`. */
export const ProjectSessionSchema = z.object({
  session_id: z.string(),
  account_id: z.string(),
  project_id: z.string(),
  branch_name: z.string(),
  base_ref: z.string(),
  sandbox_provider: SandboxProviderSchema,
  sandbox_id: z.string().nullable(),
  sandbox_url: z.string().nullable(),
  opencode_session_id: z.string().nullable(),
  runtime_session_id: z.string().nullable(),
  runtime_protocol: z.enum(['acp', 'opencode']).nullable().optional(),
  runtime_id: z.string().nullable().optional(),
  acp_session_id: z.string().nullable().optional(),
  /** Resolved display name: the user-set override, else the auto title. */
  name: z.string().nullable(),
  /** The user-set override alone, so clients can tell it apart from the auto title. */
  custom_name: z.string().nullable(),
  agent_name: z.string(),
  status: SessionStatusSchema,
  error: z.string().nullable(),
  metadata: JsonObjectSchema,
  opencode_sessions: z.array(z.unknown()),
  created_by: z.string().nullable(),
  owner_email: z.string().nullable(),
  visibility: SessionVisibilitySchema,
  sharing: SharingIntentSchema,
  is_owner: z.boolean(),
  can_manage_sharing: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ProjectSession = z.infer<typeof ProjectSessionSchema>;

export const SESSION_SANDBOX_STATUSES = [
  'provisioning',
  'active',
  'stopped',
  'error',
  'archived',
] as const;
export const SessionSandboxStatusSchema = z.enum(SESSION_SANDBOX_STATUSES);
export type SessionSandboxStatus = z.infer<typeof SessionSandboxStatusSchema>;

/** A session_sandboxes row as serialized onto `SessionStartResult.sandbox`. */
export const ProjectSessionSandboxSchema = z.object({
  sandbox_id: z.string(),
  session_id: z.string(),
  project_id: z.string(),
  account_id: z.string(),
  provider: SandboxProviderSchema,
  external_id: z.string().nullable(),
  base_url: z.string().nullable(),
  status: SessionSandboxStatusSchema,
  config: JsonObjectSchema,
  metadata: JsonObjectSchema,
  last_used_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ProjectSessionSandbox = z.infer<typeof ProjectSessionSandboxSchema>;

export const SESSION_START_STAGES = [
  'provisioning',
  'starting',
  'ready',
  'stopped',
  'failed',
] as const;
export const SessionStartStageSchema = z.enum(SESSION_START_STAGES);
export type SessionStartStage = z.infer<typeof SessionStartStageSchema>;

/**
 * The readiness payload of POST /v1/projects/:id/sessions/:id/start — the one
 * object clients poll until `stage === 'ready'`.
 */
export const SessionStartResultSchema = z.object({
  /** Coarse lifecycle stage the client renders + polls on. */
  stage: SessionStartStageSchema,
  /** Immutable project-session agent bound at session creation. */
  agent_name: z.string(),
  /** Whether polling /start again can make progress (false = terminal). */
  retriable: z.boolean(),
  /** Serialized session_sandboxes row, or null while none is usable. */
  sandbox: ProjectSessionSandboxSchema.nullable(),
  /** Canonical OpenCode root pin, resolved server-side once the box is up. */
  opencode_session_id: z.string().nullable(),
  /** Canonical runtime transport. ACP is the v3 path; opencode is v1/v2 compatibility. */
  runtime_protocol: z.enum(['acp', 'opencode']).nullable().optional(),
  /** Runtime process/server identity, independent of the ACP conversation. */
  runtime_id: z.string().nullable().optional(),
  /** Runtime-owned conversation id. For ACP this is assigned by session/new. */
  runtime_session_id: z.string().nullable().optional(),
  /**
   * Relative proxy path for this session's OpenCode runtime (port 8000),
   * composed by the client against its configured backend URL. The server owns
   * the proxy scheme; absent until the box has an external_id.
   */
  runtime_url: z.string().nullable().optional(),
  reason: z.string().optional(),
});
export type SessionStartResult = z.infer<typeof SessionStartResultSchema>;

/**
 * The 202 envelope of POST /v1/projects/:id/sessions when the create is
 * accepted asynchronously instead of returning a session row.
 */
export const SessionCreateAcceptedSchema = z.object({
  status: z.string(),
  command_id: z.string().nullable(),
  session_id: z.string().nullable(),
  reason: z.string().nullable(),
});
export type SessionCreateAccepted = z.infer<typeof SessionCreateAcceptedSchema>;

/** One trigger entry as emitted by `loadTriggersForResponse`. */
export const TriggerSchema = z.object({
  slug: z.string(),
  path: z.string(),
  name: z.string(),
  type: z.enum(['cron', 'webhook']),
  agent: z.string(),
  /** Wire-form model (`provider/model`) or null for "Default". */
  model: z.string().nullable(),
  enabled: z.boolean(),
  cron: z.string().nullable(),
  run_at: z.string().nullable(),
  timezone: z.string(),
  secret_env: z.string().nullable(),
  prompt_template: z.string(),
  session_mode: z.enum(['fresh', 'reuse']),
  last_fired_at: z.string().nullable(),
  last_status: z.string().nullable(),
  last_error: z.string().nullable(),
  last_attempt_at: z.string().nullable(),
  webhook_url: z.string().nullable(),
});
export type Trigger = z.infer<typeof TriggerSchema>;

/**
 * The actual GET /v1/projects/:id/triggers response: an envelope, not a bare
 * array (specs + per-project pause switch + manifest parse errors).
 */
export const TriggerListSchema = z.object({
  triggers: z.array(TriggerSchema),
  triggers_paused: z.boolean(),
  errors: z.array(z.object({ slug: z.string(), path: z.string(), error: z.string() })),
});
export type TriggerList = z.infer<typeof TriggerListSchema>;

/**
 * The per-user view of one secret, as built by `buildSecretView`: a secret is
 * `{ identifier, name (the env var KEY), value }`. `identifier` is unique per
 * project — the handle an agent's `secrets` grant references and the UI
 * shows. `name` (the KEY) is NOT unique — multiple identifiers may share one
 * (e.g. GMAPS-primary / GMAPS-backup, both GOOGLE_MAPS_API_KEY). Values are
 * never serialized.
 *
 * Authorization is centralized on the agent grant (by identifier) — there is
 * no per-secret member/group sharing and no resource-side agent allow-list
 * (both retired); every project member with read access sees every secret.
 */
export const SecretSchema = z.object({
  /** Unique per project. The handle an agent's `secrets` grant references. */
  identifier: z.string(),
  /** The env var KEY injected into the sandbox. Not unique. */
  name: z.string(),
  project_id: z.string(),
  secret_id: z.string().nullable(),
  created_by: z.string().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  system: z.boolean(),
  readonly: z.boolean(),
  purpose: z.literal('git_auth').nullable(),
  can_rotate: z.boolean(),
  managed_by: z.literal('project_secret').nullable(),
  /** Is a shared project value set at all. */
  configured: z.boolean(),
  /** The caller's private override (value omitted), or null. Used today only by
   *  the CODEX_AUTH_JSON per-user provider login. */
  mine: z.object({ active: z.boolean(), updated_at: z.string() }).nullable(),
  /** Which value actually gets injected into the caller's sessions. */
  effective_source: z.enum(['mine', 'shared', 'none']),
  can_manage_shared: z.boolean(),
});
export type Secret = z.infer<typeof SecretSchema>;
