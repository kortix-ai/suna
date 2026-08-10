/**
 * @kortix/api-contract — the shared wire contract for the Kortix platform API.
 *
 * Zod schemas + inferred TS types describing EXACTLY what apps/api serializes
 * onto the wire today. The API serializers
 * (apps/api/src/projects/lib/serializers.ts et al) are the behavioral source
 * of truth. Response schemas are descriptive. Request schemas validate public
 * input and can normalize deprecated input aliases to canonical fields.
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
 * Effective on/off map for every feature flag. Keys mirror the registry in
 * apps/api/src/feature-flags/registry.ts, which imports `FeatureFlagKey` from
 * here — adding a flag there without updating this map fails typecheck.
 *
 * Wire note: the serialized project fields keep their historical names
 * (`experimental`, `experimental_features`) and the override map lives at
 * `projects.metadata.experimental` — both are stable wire/storage details.
 * Code-level names are the FeatureFlag* family; the Experimental* exports
 * below are deprecated aliases kept for published-SDK compatibility.
 */
export const FeatureFlagMapSchema = z.object({
  agent_tunnel: z.boolean(),
  marketplace: z.boolean(),
  connectors_api_discover: z.boolean(),
  agentmail_email: z.boolean(),
  teams: z.boolean(),
  voice: z.boolean(),
  llm_gateway: z.boolean(),
  review_center: z.boolean(),
  meta_agent: z.boolean(),
  apps: z.boolean(),
});
export type FeatureFlagMap = z.infer<typeof FeatureFlagMapSchema>;

export const FeatureFlagKeySchema = FeatureFlagMapSchema.keyof();
export type FeatureFlagKey = z.infer<typeof FeatureFlagKeySchema>;
export const FEATURE_FLAG_KEYS = FeatureFlagKeySchema.options;

/** How settled a flag's surface is — a badge, not a mechanism. A `stable`
 *  feature can still ship behind a flag (dark launch, gradual rollout). */
export const FeatureFlagStabilitySchema = z.enum(['experimental', 'beta', 'stable']);
export type FeatureFlagStability = z.infer<typeof FeatureFlagStabilitySchema>;

/** One catalog entry of the self-describing feature-flag UI list. */
export const FeatureFlagViewSchema = z.object({
  key: FeatureFlagKeySchema,
  name: z.string(),
  description: z.string(),
  stability: FeatureFlagStabilitySchema,
  available: z.boolean(),
  enabled: z.boolean(),
  overridden: z.boolean(),
});
export type FeatureFlagView = z.infer<typeof FeatureFlagViewSchema>;

/**
 * Standard error body for a route whose feature flag is off for the project:
 * `403` with `code: 'feature_disabled'`. Emitted only after membership authz,
 * so it reveals nothing to non-members.
 */
export const FeatureDisabledErrorSchema = z.object({
  error: z.string(),
  code: z.literal('feature_disabled'),
  feature: FeatureFlagKeySchema,
});
export type FeatureDisabledError = z.infer<typeof FeatureDisabledErrorSchema>;

/** @deprecated Use {@link FeatureFlagMapSchema}. */
export const ExperimentalFeatureMapSchema = FeatureFlagMapSchema;
/** @deprecated Use {@link FeatureFlagMap}. */
export type ExperimentalFeatureMap = FeatureFlagMap;
/** @deprecated Use {@link FeatureFlagKeySchema}. */
export const ExperimentalFeatureKeySchema = FeatureFlagKeySchema;
/** @deprecated Use {@link FeatureFlagKey}. */
export type ExperimentalFeatureKey = FeatureFlagKey;
/** @deprecated Use {@link FEATURE_FLAG_KEYS}. */
export const EXPERIMENTAL_FEATURE_KEYS = FEATURE_FLAG_KEYS;
/** @deprecated Use {@link FeatureFlagViewSchema}. */
export const ExperimentalFeatureViewSchema = FeatureFlagViewSchema;
/** @deprecated Use {@link FeatureFlagView}. */
export type ExperimentalFeatureView = FeatureFlagView;

/** Assignable project roles (`user`/`viewer` are deprecated and no longer emitted). */
export const PROJECT_ROLES = ['manager', 'editor', 'member'] as const;
export const ProjectRoleSchema = z.enum(PROJECT_ROLES);
export type ProjectRole = z.infer<typeof ProjectRoleSchema>;
/** Canonical domain name. ProjectRole remains a compatibility export. */
export const WorkspaceRoleSchema = ProjectRoleSchema;
export type WorkspaceRole = ProjectRole;

/** Every sandbox provider the current platform can select or emit. */
export const SANDBOX_PROVIDERS = ['daytona', 'platinum', 'e2b'] as const;
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
export const WorkspaceSharingIntentSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('workspace') }),
  z.object({ mode: z.literal('private'), ownerId: z.string() }),
  z.object({
    mode: z.literal('members'),
    memberIds: z.array(z.string()).readonly().optional(),
    groupIds: z.array(z.string()).readonly().optional(),
  }),
]);
export type WorkspaceSharingIntent = z.infer<typeof WorkspaceSharingIntentSchema>;

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
  /** Per-project emoji shown on the project card, or null when unset/invalid. */
  icon: z.string().nullable(),
  /** A named glyph + colour, the alternative to `icon`. At most one of the two
   *  is ever set — the API deletes the other whenever either is written. */
  icon_glyph: z.object({ name: z.string(), color: z.string() }).nullable(),
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
  /** Per-project provider pin, surfaced only while still usable. */
  default_sandbox_provider: SandboxProviderSchema.nullable(),
  available_sandbox_providers: z.array(SandboxProviderSchema),
});
export type Project = z.infer<typeof ProjectSchema>;
/** Canonical domain name. Project remains a compatibility export. */
export const WorkspaceSchema = ProjectSchema.omit({
  project_id: true,
  project_role: true,
  effective_project_role: true,
}).extend({
  workspace_id: z.string(),
  /** Explicit project_members role, or null when access is inherited. */
  workspace_role: WorkspaceRoleSchema.nullable(),
  /** UI label for the caller's effective role (not an auth decision). */
  effective_workspace_role: WorkspaceRoleSchema.nullable(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

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
export const WorkspaceSessionVisibilitySchema = z.enum(['private', 'workspace', 'restricted']);
export type WorkspaceSessionVisibility = z.infer<typeof WorkspaceSessionVisibilitySchema>;

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
const SessionConnectorBindingAliasSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_-]{0,127}$/,
    'connector binding aliases must be lower-case connector slugs',
  );

export const SessionConnectorBindingInputSchema = z
  .object({
    connection_id: z.string().uuid(),
  })
  .strict();
export type SessionConnectorBindingInput = z.input<
  typeof SessionConnectorBindingInputSchema
>;

export const SessionConnectorBindingSchema = z
  .object({
    connection_id: z.string().uuid(),
  })
  .strict();
export type SessionConnectorBinding = z.infer<typeof SessionConnectorBindingSchema>;

export const SessionConnectorBindingsInputSchema = z
  .record(SessionConnectorBindingAliasSchema, SessionConnectorBindingInputSchema)
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > SESSION_CONNECTOR_BINDINGS_MAX_KEYS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `connector_bindings may contain at most ${SESSION_CONNECTOR_BINDINGS_MAX_KEYS} entries`,
      });
    }
  });
export type SessionConnectorBindingsInput = z.input<typeof SessionConnectorBindingsInputSchema>;

export const SessionConnectorBindingsSchema = z
  .record(SessionConnectorBindingAliasSchema, SessionConnectorBindingSchema)
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > SESSION_CONNECTOR_BINDINGS_MAX_KEYS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `connector_bindings may contain at most ${SESSION_CONNECTOR_BINDINGS_MAX_KEYS} entries`,
      });
    }
  });
export type SessionConnectorBindings = z.infer<typeof SessionConnectorBindingsSchema>;

export const SESSION_SECRETS_ALLOWLIST_MAX_KEYS = 128;
/**
 * A per-session secrets allowlist: project-secret IDENTIFIERS (never values)
 * this session may receive. Backend-only. Narrows the resolved set — see
 * intersectSecretGrants. Identifier grammar mirrors project_secrets.identifier
 * (apps/api secrets.ts IDENTIFIER_REGEX).
 */
export const SessionSecretsAllowlistSchema = z
  .array(
    z
      .string()
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/,
        'each secrets entry must be a project-secret identifier',
      ),
  )
  .max(
    SESSION_SECRETS_ALLOWLIST_MAX_KEYS,
    `secrets may contain at most ${SESSION_SECRETS_ALLOWLIST_MAX_KEYS} identifiers`,
  );
export type SessionSecretsAllowlist = z.infer<typeof SessionSecretsAllowlistSchema>;

export const ConnectorAuthorizationStrategySchema = z.enum(['project', 'user']);
export type ConnectorAuthorizationStrategy = z.infer<typeof ConnectorAuthorizationStrategySchema>;
export const WorkspaceConnectorAuthorizationStrategySchema = z.enum(['workspace', 'user']);
export type WorkspaceConnectorAuthorizationStrategy = z.infer<
  typeof WorkspaceConnectorAuthorizationStrategySchema
>;

/**
 * Connector aliases a session REQUIRES, whether or not anything is connected.
 *
 * Distinct from `connector_bindings`, which says "use THIS connection for that
 * alias" and therefore cannot express the case that matters most: a session that
 * needs Gmail and has no Gmail connected yet. Naming an alias here is what makes
 * the pre-flight refuse the next turn with a connect prompt instead of letting
 * the agent discover it mid-answer.
 */
export const SessionRequiredConnectorsSchema = z
  .array(z.string().min(1).max(128))
  .max(64, 'require_connectors may contain at most 64 aliases');
export type SessionRequiredConnectors = z.infer<typeof SessionRequiredConnectorsSchema>;

export const SessionScopeInputSchema = z
  .object({
    secrets: SessionSecretsAllowlistSchema.nullable().optional(),
    connector_bindings: SessionConnectorBindingsInputSchema.optional(),
    require_connectors: SessionRequiredConnectorsSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (value) =>
      Object.hasOwn(value, 'secrets') ||
      Object.hasOwn(value, 'connector_bindings') ||
      Object.hasOwn(value, 'require_connectors'),
    'Supply `secrets`, `connector_bindings`, `require_connectors`, or any combination',
  );
export type SessionScopeInput = z.input<typeof SessionScopeInputSchema>;

export const SessionScopeSchema = z
  .object({
    secrets_allowlist: SessionSecretsAllowlistSchema.nullable(),
    required_connectors: SessionRequiredConnectorsSchema.nullable(),
    connector_bindings: SessionConnectorBindingsSchema,
    dropped_secrets: z.array(z.string()),
    added_secrets: z.array(z.string()),
    dropped_bindings: z.array(z.string()),
    retroactive: z.boolean(),
    /**
     * True when the new secrets scope was pushed to the live sandbox and
     * OpenCode was restarted to pick it up — the change is in effect NOW.
     * False when there was no active sandbox to push to (the change is stored
     * and applies at the next boot), or when `secrets` was not part of this
     * request. Mirrors the model route's `applied_live`.
     */
    applied_live: z.boolean().optional(),
    /**
     * Present only when a live push was REQUIRED (the secrets scope changed and
     * an active sandbox exists) and FAILED — the row is written but the running
     * harness still answers from the OLD scope. `applied_live: false` cannot
     * express this on its own (it is also the benign no-active-sandbox answer),
     * so a client must read THIS to tell a half-applied change from a stored one.
     */
    push_failed: z.literal(true).optional(),
    push_reason: z.string().optional(),
    detail: z.string(),
  })
  .strict();
export type SessionScope = z.infer<typeof SessionScopeSchema>;

export const RequiredConnectorConnectionSchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/),
    name: z.string().min(1),
    authorization_strategy: ConnectorAuthorizationStrategySchema,
  })
  .strict();
export type RequiredConnectorConnection = z.infer<
  typeof RequiredConnectorConnectionSchema
>;

export const ConnectorConnectionRequiredErrorSchema = z
  .object({
    code: z.literal('CONNECTOR_CONNECTION_REQUIRED'),
    message: z.string().min(1),
    connector_connections: z.array(RequiredConnectorConnectionSchema).min(1),
  })
  .strict();
export type ConnectorConnectionRequiredError = z.infer<
  typeof ConnectorConnectionRequiredErrorSchema
>;

export const WorkspaceRequiredConnectorConnectionSchema =
  RequiredConnectorConnectionSchema.omit({ authorization_strategy: true }).extend({
    authorization_strategy: WorkspaceConnectorAuthorizationStrategySchema,
  });
export type WorkspaceRequiredConnectorConnection = z.infer<
  typeof WorkspaceRequiredConnectorConnectionSchema
>;
export const WorkspaceConnectorConnectionRequiredErrorSchema =
  ConnectorConnectionRequiredErrorSchema.omit({ connector_connections: true }).extend({
    connector_connections: z.array(WorkspaceRequiredConnectorConnectionSchema).min(1),
  });
export type WorkspaceConnectorConnectionRequiredError = z.infer<
  typeof WorkspaceConnectorConnectionRequiredErrorSchema
>;

export const ConnectionOwnerTypeSchema = z.enum([
  'agent',
  'member',
  'subject',
  'external',
]);
export const ConnectionStatusSchema = z.enum(['active', 'revoked', 'error']);
export const ConnectionMetadataSchema = z
  .record(
    z
      .string()
      .regex(/^[a-z][a-z0-9_.-]{0,63}$/)
      .refine(
        (key) =>
          !/(^|[._-])(token|secret|password|credential|api[_-]?key|private[_-]?key|authorization|cookie)([._-]|$)/.test(
            key,
          ),
        'connection metadata is non-secret',
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
export const ConnectionSchema = z.object({
  connection_id: z.string().uuid(),
  connector_alias: z.string(),
  owner_type: z.enum(['project', 'agent', 'member', 'subject', 'external']),
  owner_id: z.string().nullable(),
  label: z.string(),
  status: ConnectionStatusSchema,
  is_default: z.boolean(),
  metadata: ConnectionMetadataSchema,
});
export type Connection = z.infer<typeof ConnectionSchema>;
export const WorkspaceConnectionSchema = ConnectionSchema.omit({ owner_type: true }).extend({
  owner_type: z.enum(['workspace', 'agent', 'member', 'subject', 'external']),
});
export type WorkspaceConnection = z.infer<typeof WorkspaceConnectionSchema>;

export const ReconcileConnectionInputSchema = z
  .object({
    connector_alias: z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/),
    // `project` = a project-shared connection (several are allowed per connector,
    // distinguished by label); it takes no owner_id. Every other owner type
    // requires one. Creating a project connection needs the connections-manage
    // capability — enforced at the route.
    owner_type: z.enum(['project', 'agent', 'member', 'subject', 'external']),
    owner_id: z.string().trim().min(1).max(512).optional(),
    label: z.string().trim().min(1).max(255),
    metadata: ConnectionMetadataSchema.optional(),
  })
  .strict();
export type ReconcileConnectionInput = z.infer<typeof ReconcileConnectionInputSchema>;
export const WorkspaceReconcileConnectionInputSchema = ReconcileConnectionInputSchema.omit({
  owner_type: true,
}).extend({
  owner_type: z.enum(['workspace', 'agent', 'member', 'subject', 'external']),
});
export type WorkspaceReconcileConnectionInput = z.infer<
  typeof WorkspaceReconcileConnectionInputSchema
>;

export const OAuth2ClientCredentialsSchema = z
  .object({
    type: z.literal('oauth2_client_credentials'),
    token_url: z
      .string()
      .url()
      .refine((value) => value.startsWith('https://'), 'token_url must use https'),
    client_id: z.string().trim().min(1).max(1024),
    token_endpoint_auth_method: z.enum([
      'none',
      'client_secret_post',
      'client_secret_basic',
      'client_secret_jwt',
      'private_key_jwt',
    ]),
    client_secret: z.string().min(1).max(65536).optional(),
    private_key: z.string().min(1).max(65536).optional(),
    certificate_thumbprint: z.string().min(1).max(512).optional(),
    scopes: z.array(z.string().trim().min(1).max(2048)).max(64).optional(),
    resource: z.string().trim().min(1).max(4096).optional(),
    audience: z.string().trim().min(1).max(4096).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const usesSecret =
      value.token_endpoint_auth_method === 'client_secret_post' ||
      value.token_endpoint_auth_method === 'client_secret_basic' ||
      value.token_endpoint_auth_method === 'client_secret_jwt';
    if (usesSecret && !value.client_secret) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['client_secret'],
        message: 'client_secret is required for the selected authentication method',
      });
    }
    if (value.token_endpoint_auth_method === 'private_key_jwt' && !value.private_key) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['private_key'],
        message: 'private_key is required for private_key_jwt',
      });
    }
  });
export type OAuth2ClientCredentials = z.infer<typeof OAuth2ClientCredentialsSchema>;

const OAuth2HttpsUrlSchema = z
  .string()
  .url()
  .refine((value) => value.startsWith('https://'), 'OAuth2 endpoints must use https');

const OAuth2RedirectUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))
    );
  }, 'redirect URI must use https except on loopback');

export const OAuth2TokenEndpointAuthMethodSchema = z.enum([
  'none',
  'client_secret_basic',
  'client_secret_post',
  'client_secret_jwt',
  'private_key_jwt',
]);
export type OAuth2TokenEndpointAuthMethod = z.infer<typeof OAuth2TokenEndpointAuthMethodSchema>;

const OAuth2ApplicationFields = {
  discovery_url: OAuth2HttpsUrlSchema.optional(),
  authorization_url: OAuth2HttpsUrlSchema.optional(),
  token_url: OAuth2HttpsUrlSchema.optional(),
  device_authorization_url: OAuth2HttpsUrlSchema.optional(),
  revocation_url: OAuth2HttpsUrlSchema.optional(),
  client_id: z.string().trim().min(1).max(1024),
  token_endpoint_auth_method: OAuth2TokenEndpointAuthMethodSchema,
  client_secret: z.string().min(1).max(65536).optional(),
  private_key: z.string().min(1).max(65536).optional(),
  scopes: z.array(z.string().trim().min(1).max(2048)).max(64).optional(),
  resource: z.string().trim().min(1).max(4096).optional(),
  audience: z.string().trim().min(1).max(4096).optional(),
  authorization_params: z.record(z.string().max(4096)).optional(),
  token_params: z.record(z.string().max(4096)).optional(),
};

export const OAuth2ApplicationInputSchema = z
  .object(OAuth2ApplicationFields)
  .strict()
  .superRefine((value, ctx) => {
    if (!value.discovery_url && !value.token_url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['token_url'],
        message: 'token_url or discovery_url is required',
      });
    }
    if (
      (value.token_endpoint_auth_method === 'client_secret_basic' ||
        value.token_endpoint_auth_method === 'client_secret_post' ||
        value.token_endpoint_auth_method === 'client_secret_jwt') &&
      !value.client_secret
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['client_secret'],
        message: 'client_secret is required for the selected authentication method',
      });
    }
    if (value.token_endpoint_auth_method === 'private_key_jwt' && !value.private_key) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['private_key'],
        message: 'private_key is required for private_key_jwt',
      });
    }
  });
export type OAuth2ApplicationInput = z.infer<typeof OAuth2ApplicationInputSchema>;

export const OAuth2ApplicationViewSchema = z
  .object(OAuth2ApplicationFields)
  .omit({
    client_secret: true,
    private_key: true,
  })
  .extend({
    has_client_secret: z.boolean(),
    has_private_key: z.boolean(),
  });
export type OAuth2ApplicationView = z.infer<typeof OAuth2ApplicationViewSchema>;

export const OAuth2DiscoveryInputSchema = z
  .object({ discovery_url: OAuth2HttpsUrlSchema })
  .strict();
export type OAuth2DiscoveryInput = z.infer<typeof OAuth2DiscoveryInputSchema>;

const OAuth2OptionalScopesSchema = z.array(z.string().trim().min(1).max(2048)).max(64).optional();

export const OAuth2AuthorizationStartInputSchema = z
  .object({
    scopes: OAuth2OptionalScopesSchema,
    success_redirect_uri: OAuth2RedirectUrlSchema.optional(),
    error_redirect_uri: OAuth2RedirectUrlSchema.optional(),
  })
  .strict();
export type OAuth2AuthorizationStartInput = z.infer<typeof OAuth2AuthorizationStartInputSchema>;

export const OAuth2DeviceAuthorizationStartInputSchema = z
  .object({ scopes: OAuth2OptionalScopesSchema })
  .strict();
export type OAuth2DeviceAuthorizationStartInput = z.infer<
  typeof OAuth2DeviceAuthorizationStartInputSchema
>;

export const OAuth2AuthorizationStartResultSchema = z
  .object({
    authorization_url: OAuth2HttpsUrlSchema,
    expires_at: z.string().datetime(),
  })
  .strict();
export type OAuth2AuthorizationStartResult = z.infer<typeof OAuth2AuthorizationStartResultSchema>;

export const OAuth2DeviceAuthorizationStartResultSchema = z
  .object({
    session_id: z.string().uuid(),
    user_code: z.string().min(1).max(1024),
    verification_uri: OAuth2HttpsUrlSchema,
    verification_uri_complete: OAuth2HttpsUrlSchema.optional(),
    expires_at: z.string().datetime(),
    interval_seconds: z.number().int().min(1).max(300),
  })
  .strict();
export type OAuth2DeviceAuthorizationStartResult = z.infer<
  typeof OAuth2DeviceAuthorizationStartResultSchema
>;

export const OAuth2ConnectionStatusSchema = z
  .object({
    status: z.enum(['not_configured', 'ready', 'pending', 'active', 'error', 'revoked']),
    expires_at: z.string().datetime().nullable().optional(),
    scopes: z.array(z.string()).optional(),
    error_code: z.string().max(128).nullable().optional(),
  })
  .strict();
export type OAuth2ConnectionStatus = z.infer<typeof OAuth2ConnectionStatusSchema>;

export const UpdateConnectionCredentialInputSchema = z.union([
  z
    .object({
      value: z.string().min(1).max(65536),
      kind: z.enum(['secret', 'connection']).optional(),
    })
    .strict(),
  z.object({ oauth2: OAuth2ClientCredentialsSchema }).strict(),
]);
export type UpdateConnectionCredentialInput = z.infer<
  typeof UpdateConnectionCredentialInputSchema
>;
export const PendingSessionPromptSchema = z
  .object({
    text: z.string().max(1_000_000),
    agent: z.string().min(1).nullable().optional(),
    model: z
      .object({ providerID: z.string().min(1), modelID: z.string().min(1) })
      .strict()
      .nullable()
      .optional(),
    variant: z.string().min(1).nullable().optional(),
    attachment_names: z.array(z.string().min(1).max(512)).max(50).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.text.trim().length > 0 || (value.attachment_names?.length ?? 0) > 0) return;
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['text'],
      message: 'A pending prompt requires text or an attachment name.',
    });
  });
export type PendingSessionPrompt = z.infer<typeof PendingSessionPromptSchema>;

/** Authoritative public body for POST /v1/projects/:workspaceId/sessions. */
export const SessionCreateInputSchema = z
  .object({
    base_ref: z.string().min(1).optional(),
    agent_name: z.string().min(1).optional(),
    sandbox_slug: z.string().min(1).optional(),
    initial_prompt: z.string().optional(),
    pending_prompt: PendingSessionPromptSchema.optional(),
    // The clean text auto-titling derives from, when `initial_prompt` is a
    // rendered envelope (channel scaffolding, a coordinator's session
    // contract, a --with-file manifest) rather than the user's own words.
    title_source: z.string().optional(),
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
    connector_bindings: SessionConnectorBindingsInputSchema.optional(),
    // When `connector_bindings` is set, unbound aliases fail closed.
    // `inherit_unbound: true` keeps strategy-based default resolution for them.
    inherit_unbound: z.boolean().optional(),
    // Require each named connector to resolve a connection that matches its
    // project-or-user strategy. Missing connections return the
    // structured CONNECTOR_CONNECTION_REQUIRED response before provisioning.
    require_connectors: z
      .array(
        z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/, 'connector alias must be a lower-case slug'),
      )
      .max(SESSION_CONNECTOR_BINDINGS_MAX_KEYS)
      .optional(),
    // Backend-only: narrow which project secrets (by identifier) this session's
    // sandbox receives, from the default agent-grant set down to this list. `[]`
    // means inject zero project secrets. Backend origin required — a non-backend
    // caller supplying it is rejected 403 (canOverride 'secrets').
    secrets: SessionSecretsAllowlistSchema.optional(),
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
  owner_name: z.string().nullable().optional(),
  owner_type: z.enum(['user', 'service_account', 'unknown']).nullable().optional(),
  visibility: SessionVisibilitySchema,
  /** Policy class the session was created under (derived, never client-set). */
  origin: z.enum(['user', 'trigger', 'schedule', 'backend', 'system']),
  /** Backend-set per-session secrets allowlist (identifiers); null = no narrowing. */
  secrets_allowlist: SessionSecretsAllowlistSchema.nullable(),
  sharing: SharingIntentSchema,
  is_owner: z.boolean(),
  can_manage_sharing: z.boolean(),
  can_access: z.boolean().optional(),
  runtime_status: z
    .enum(['provisioning', 'active', 'stopped', 'error', 'archived'])
    .nullable()
    .optional(),
  deleted_at: z.string().nullable().optional(),
  deleted_by: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ProjectSession = z.infer<typeof ProjectSessionSchema>;
/** Canonical domain name. ProjectSession remains a compatibility export. */
export const WorkspaceSessionSchema = ProjectSessionSchema.omit({
  project_id: true,
  visibility: true,
  sharing: true,
}).extend({
  workspace_id: z.string(),
  visibility: WorkspaceSessionVisibilitySchema,
  sharing: WorkspaceSharingIntentSchema,
});
export type WorkspaceSession = z.infer<typeof WorkspaceSessionSchema>;

export const WarmProjectSessionWorkspaceRefreshSchema = z.object({
  status: z.enum(['skipped', 'unchanged', 'updated', 'failed']),
  before_sha: z.string().nullable().optional(),
  after_sha: z.string().nullable().optional(),
  error: z.string().optional(),
});
export type WarmProjectSessionWorkspaceRefresh = z.infer<
  typeof WarmProjectSessionWorkspaceRefreshSchema
>;

export const WarmProjectSessionResultSchema = z.object({
  session: ProjectSessionSchema,
  reused: z.boolean(),
  workspace_refresh: WarmProjectSessionWorkspaceRefreshSchema,
});
export type WarmProjectSessionResult = z.infer<typeof WarmProjectSessionResultSchema>;
export const WarmWorkspaceSessionResultSchema = WarmProjectSessionResultSchema.omit({
  session: true,
}).extend({ session: WorkspaceSessionSchema });
export type WarmWorkspaceSessionResult = z.infer<typeof WarmWorkspaceSessionResultSchema>;

export const ClaimWarmProjectSessionInputSchema = z
  .object({
    session_id: z
      .string()
      .regex(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        'session_id must be an RFC 4122 v4 UUID',
      ),
    agent_name: z.string().min(1).optional(),
    sandbox_slug: z.string().min(1).optional(),
    pending_prompt: PendingSessionPromptSchema.optional(),
  })
  .strict();
export type ClaimWarmProjectSessionInput = z.infer<typeof ClaimWarmProjectSessionInputSchema>;
export const ClaimWarmWorkspaceSessionInputSchema = ClaimWarmProjectSessionInputSchema;
export type ClaimWarmWorkspaceSessionInput = ClaimWarmProjectSessionInput;

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
export const WorkspaceSessionSandboxSchema = ProjectSessionSandboxSchema.omit({ project_id: true }).extend({
  workspace_id: z.string(),
});
export type WorkspaceSessionSandbox = z.infer<typeof WorkspaceSessionSandboxSchema>;

export const SESSION_START_STAGES = [
  'provisioning',
  'starting',
  'ready',
  'stopped',
  'failed',
] as const;
export const SessionStartStageSchema = z.enum(SESSION_START_STAGES);
export type SessionStartStage = z.infer<typeof SessionStartStageSchema>;

export const SessionStartFailureSchema = z
  .object({
    category: z.enum([
      'provider-capacity',
      'git-auth',
      'unsupported-secret-delivery',
      'sandbox-provider',
    ]),
    message: z.string(),
    retryable: z.boolean(),
  })
  .strict();
export type SessionStartFailure = z.infer<typeof SessionStartFailureSchema>;

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
  /** Stable terminal failure. Raw provider text remains in sandbox metadata. */
  failure: SessionStartFailureSchema.nullable().optional(),
  /** Server-selected OpenCode REST transport. */
  runtime_transport: z.literal('rest').optional(),
  /**
   * Relative proxy path for this session's OpenCode runtime (port 8000),
   * composed by the client against its configured backend URL. The server owns
   * the proxy scheme; absent until the box has an external_id.
   */
  runtime_url: z.string().nullable().optional(),
  reason: z.string().optional(),
});
export type SessionStartResult = z.infer<typeof SessionStartResultSchema>;

/** Canonical Workspace readiness payload for `/v1/workspaces/**`. */
export const WorkspaceSessionStartResultSchema = SessionStartResultSchema.omit({ sandbox: true }).extend({
  sandbox: WorkspaceSessionSandboxSchema.nullable(),
});
export type WorkspaceSessionStartResult = z.infer<typeof WorkspaceSessionStartResultSchema>;

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
  session_mode: z.enum(['fresh', 'reuse', 'pinned', 'keyed']),
  /** For session_mode === 'pinned' only: the exact session id looped. Null otherwise. */
  session_id: z.string().nullable(),
  /**
   * For session_mode === 'keyed' only: the `{{ body.path }}` template rendered
   * per delivery to pick one session per key. Null otherwise.
   */
  session_key: z.string().nullable(),
  /** Payload paths that must match for the trigger to fire. Null when unfiltered. */
  filter: z.record(z.string(), z.string()).nullable(),
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
export const SecretDeliveryStrategySchema = z.enum(['runtime', 'egress', 'broker', 'denied']);
export type SecretDeliveryStrategy = z.infer<typeof SecretDeliveryStrategySchema>;

export const SecretConsumerSchema = z.enum([
  'sandbox',
  'llm_gateway',
  'connector',
  'git_proxy',
  'http_broker',
  'network',
]);
export type SecretConsumer = z.infer<typeof SecretConsumerSchema>;

export const SecretDeliveryStatusSchema = z.enum(['available', 'unavailable', 'disabled']);
export type SecretDeliveryStatus = z.infer<typeof SecretDeliveryStatusSchema>;

export const SecretInjectionSlotSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('header'), name: z.string(), template: z.string().optional() }),
  z.object({ kind: z.literal('query'), name: z.string() }),
  z.object({ kind: z.literal('json_body_field'), path: z.string() }),
]);

export const SecretEgressPolicySchema = z.object({
  backend: z.enum(['llm_gateway', 'connector', 'git_proxy', 'kortix_fetch']).optional(),
  base_url_env: z.string().optional(),
  rules: z.array(
    z.object({
      host: z.string(),
      methods: z.array(z.string()).optional(),
      path: z.string().optional(),
      inject: SecretInjectionSlotSchema.optional(),
    }),
  ),
  inject: SecretInjectionSlotSchema,
  on_no_match: z.enum(['deny', 'observe']).optional(),
  tls: z.enum(['terminate', 'tunnel']).optional(),
});
export type SecretEgressPolicy = z.infer<typeof SecretEgressPolicySchema>;

export const UpdateSecretStrategyInputSchema = z
  .object({
    strategy: SecretDeliveryStrategySchema,
    consumer: SecretConsumerSchema.nullable().optional(),
    egress_policy: SecretEgressPolicySchema.optional(),
    handle_prefix: z.string().min(1).max(48).optional(),
  })
  .strict();
export type UpdateSecretStrategyInput = z.infer<typeof UpdateSecretStrategyInputSchema>;

export const SecretBrokerRequestSchema = z
  .object({
    url: z.string().min(1).max(4096),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).default('GET'),
    headers: z.record(z.string(), z.string().max(8192)).optional(),
    body_base64: z.string().max(1_400_000).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value.headers ?? {}).length <= 64, {
    message: 'headers must contain at most 64 entries',
    path: ['headers'],
  });
export type SecretBrokerRequest = z.infer<typeof SecretBrokerRequestSchema>;

export const SecretBrokerResponseSchema = z.object({
  status: z.number().int().min(100).max(599),
  headers: z.record(z.string(), z.string()),
  body_base64: z.string(),
});
export type SecretBrokerResponse = z.infer<typeof SecretBrokerResponseSchema>;

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
  strategy: SecretDeliveryStrategySchema,
  consumer: SecretConsumerSchema.nullable(),
  delivery_status: SecretDeliveryStatusSchema,
  network_boundary_available: z.boolean().optional(),
  egress_policy: SecretEgressPolicySchema.nullable(),
  strategy_locked: z.boolean(),
  last_rotated_at: z.string().nullable(),
  requires_rotation: z.boolean(),
});
export type Secret = z.infer<typeof SecretSchema>;

/** Canonical Workspace secret payload. Secret remains the Project compatibility shape. */
export const WorkspaceSecretSchema = SecretSchema.omit({ project_id: true }).extend({
  workspace_id: z.string(),
});
export type WorkspaceSecret = z.infer<typeof WorkspaceSecretSchema>;
