/**
 * The canonical workspace resource (design.md §3.2 C5, K3):
 *
 *   GET    /v1/workspaces       every workspace of the caller, one request
 *   POST   /v1/workspaces       create a workspace (JSON, or SSE with Accept: text/event-stream)
 *   GET    /v1/workspaces/:id   the Workspace: record + role + state + settings block
 *   PATCH  /v1/workspaces/:id   name, icon, branch, manifest path, secret default
 *
 * Mounted on `/v1/workspaces` BEFORE the project-route alias
 * (`workspaceProjectsApp`), which leaves these four out. The legacy names keep
 * their old meaning: `GET /v1/projects` lists one account,
 * `POST /v1/projects/provision` takes `new_workspace`, `GET /v1/projects/:id`
 * is the bare project record. The handlers live in
 * `projects/routes/workspace-records.ts`.
 */
import { createRoute, z } from '@hono/zod-openapi';

import { supabaseAuth } from '../middleware/auth';
import { auth, ErrorSchema, errors, json, lenientBody, makeOpenApiApp } from '../openapi';
import {
  ProjectSchema,
  createWorkspace,
  listCallerWorkspaces,
  patchWorkspace,
  readWorkspace,
} from '../projects';
import type { AppEnv } from '../types';

export const WorkspaceRoleSchema = z
  .enum(['owner', 'admin', 'manager', 'member'])
  .openapi('WorkspaceRole', {
    description:
      'The caller’s role in the workspace. `owner` and `admin` administer it (members, billing, SSO, keys); `manager` manages its agents, skills and sessions; `member` reads and runs.',
  });

export const WorkspaceStateSchema = z.enum(['active', 'setup_required', 'deleting']).openapi('WorkspaceState', {
  description:
    '`active`: in use. `setup_required`: the workspace pays but has no repository yet (`POST /v1/workspaces/{workspaceId}/setup`); members see it. `deleting`: deleted and inside its restore window; owners only see it.',
});

const readOnly = (description: string, writer: string) =>
  `${description} Read-only here: \`PATCH /v1/workspaces/{workspaceId}\` answers 400 \`workspace_setting_read_only\`; write it with \`${writer}\`.`;

export const WorkspaceSettingsSchema = z
  .object({
    workspace_id: z.string().openapi({ description: 'The workspace id.' }),
    account_id: z.string().openapi({ deprecated: true, description: 'Deprecated: the internal billing key. Use `workspace_id`.' }),
    split_pending: z.boolean().openapi({ description: 'True while a legacy account still holds other workspaces.' }),
    member_count: z.number().openapi({ description: 'People in the workspace.' }),
    account_role: z.string().nullable().openapi({ deprecated: true, description: 'Deprecated: use the top-level `role`.' }),
    mfa_required: z.boolean().openapi({ description: readOnly('Every member must have a verified MFA factor.', 'PATCH /v1/workspaces/{workspaceId}/iam/mfa-required') }),
    session_max_lifetime_minutes: z.number().nullable().openapi({ description: readOnly('Session lifetime.', 'PATCH /v1/workspaces/{workspaceId}/iam/session-policy') }),
    session_idle_timeout_minutes: z.number().nullable().openapi({ description: readOnly('Session idle timeout.', 'PATCH /v1/workspaces/{workspaceId}/iam/session-policy') }),
    pat_max_lifetime_days: z.number().nullable().openapi({ description: readOnly('Longest key lifetime.', 'PATCH /v1/workspaces/{workspaceId}/iam/pat-policy') }),
    pat_require_expiry: z.boolean().openapi({ description: readOnly('Keys must expire.', 'PATCH /v1/workspaces/{workspaceId}/iam/pat-policy') }),
    pat_idle_revoke_days: z.number().nullable().openapi({ description: readOnly('Unused keys are revoked after this many days.', 'PATCH /v1/workspaces/{workspaceId}/iam/pat-policy') }),
    admins_see_all_sessions: z.boolean().openapi({ description: readOnly('Owners and admins see every member’s sessions.', 'PATCH /v1/workspaces/{workspaceId}/iam/session-oversight') }),
    automations_paused_at: z.string().nullable().openapi({ description: readOnly('Set while automations are paused.', 'PATCH /v1/workspaces/{workspaceId}/automations') }),
    setup_complete_at: z.string().nullable().openapi({ description: 'When the self-host setup wizard finished.' }),
    branding: z.record(z.string(), z.unknown()).nullable().openapi({ description: readOnly('Effective branding.', 'PUT /v1/workspaces/{workspaceId}/branding') }),
  })
  .passthrough()
  .openapi('WorkspaceSettings');

const workspaceFields = {
  workspace_id: z.string().openapi({ description: 'The workspace id. Equal to `project_id`. Use it in every URL and call.' }),
  role: WorkspaceRoleSchema,
  state: WorkspaceStateSchema,
  split_pending: z.boolean().openapi({ description: 'True while a legacy account still holds other workspaces.' }),
  deletion_scheduled_for: z.string().nullable().openapi({ description: 'When a `deleting` workspace is erased; null otherwise.' }),
};

export const WorkspaceSummarySchema = ProjectSchema.extend(workspaceFields).openapi('WorkspaceSummary');

export const WorkspaceSplitNoticeSchema = z
  .object({
    role: z.enum(['keeper', 'moved']).openapi({ description: '`keeper`: this workspace kept the legacy account. `moved`: it was split off.' }),
    source_name: z.string().openapi({ description: 'The legacy account’s name before the split.' }),
    completed_at: z.string().openapi({ description: 'When the legacy account’s last project moved.' }),
    billing: z.enum(['free', 'comped']).nullable().openapi({ description: 'A split-off’s plan: `free` (with this month’s free credits) or `comped` (the keeper’s plan at no charge until `comped_until`). Null for the keeper.' }),
    comped_until: z.string().nullable().openapi({ description: 'When a comped plan ends and the workspace moves to Free.' }),
  })
  .openapi('WorkspaceSplitNotice');

export const WorkspaceSchema = ProjectSchema.extend({
  ...workspaceFields,
  split_notice: WorkspaceSplitNoticeSchema.nullable().openapi({
    description: 'Set for 30 days after a legacy account with several projects became one workspace per project; null otherwise.',
  }),
  secret_default_strategy: z.enum(['runtime', 'egress', 'broker', 'denied']).openapi({
    description: 'How a secret with no strategy of its own reaches a session.',
  }),
  workspace: WorkspaceSettingsSchema.nullable().openapi({
    description: 'The workspace settings. Null when the caller reaches the workspace but may not read its settings.',
  }),
}).openapi('Workspace');

const WorkspaceIdParam = z.object({
  workspaceId: z.string().openapi({
    description: 'The workspace id (`workspace_id`, equal to `project_id`). An account id answers 404 `workspace_not_found`.',
  }),
});

const NotFound = { 404: json(ErrorSchema, 'No such workspace, or the caller cannot read it (`workspace_not_found`)') };

const CREATE_FIELDS = {
  name: z.string().openapi({ description: 'The workspace name, 1–255 characters.' }),
  icon: z.string().optional().openapi({ description: 'Workspace icon name.' }),
  icon_glyph: z.string().optional().openapi({ description: 'Workspace icon glyph.' }),
  provider: z.string().optional().openapi({ description: 'Managed Git provider. Defaults to the deployment default (github).' }),
  source_item_id: z.string().optional().openapi({ description: 'Marketplace item to clone into the new repository.' }),
  starter_template: z.string().optional().openapi({ description: 'Starter template id to seed the repository.' }),
  default_branch: z.string().optional().openapi({ description: 'Default branch. Default main.' }),
  seed_starter: z.boolean().optional().openapi({ description: 'Set false when the client makes the first commit itself.' }),
  marketplace_items: z.array(z.any()).optional().openapi({ description: 'Marketplace items to install.' }),
  idempotency_key: z.string().optional().openapi({ description: 'Makes a retry safe: the same key answers the workspace it created.' }),
};

export const workspacesRootApp = makeOpenApiApp<AppEnv>();

// biome-ignore lint/suspicious/noExplicitAny: the handlers answer plain Responses; the schemas document them.
type AnyHandler = any;

export function registerWorkspaceRootRoutes(): void {
  workspacesRootApp.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['workspaces'],
      summary: 'List workspaces',
      description:
        'Every workspace the caller may open, across every account, in one request: most recently opened first, then by name. A workspace-bound key lists its one workspace. The legacy `GET /v1/projects` keeps its old meaning (one account, `?account_id=`).',
      ...auth,
      middleware: [supabaseAuth] as const,
      responses: { 200: json(z.array(WorkspaceSummarySchema), 'The caller’s workspaces'), ...errors(401) },
    }),
    ((c: AnyHandler) => listCallerWorkspaces(c)) as AnyHandler,
  );

  workspacesRootApp.openapi(
    createRoute({
      method: 'post',
      path: '/',
      tags: ['workspaces'],
      summary: 'Create a workspace',
      description:
        'Creates a new workspace with a new managed repository. Always a new workspace: an `account_id` answers 400. Send `Accept: text/event-stream` to stream the provision phases (`data: {type:"phase"}` frames, then one `done` frame with `project` and `workspace`, or one `error` frame). 403 `new_workspace_requires_person` for an API key, a service account or a workspace-bound key; 403 `account_creation_restricted` where the deployment restricts it; 403 `impersonation_invalid`; 409 `provision_in_flight`.',
      ...auth,
      middleware: [supabaseAuth] as const,
      request: { body: { content: { 'application/json': { schema: lenientBody(CREATE_FIELDS) } } } },
      responses: {
        201: json(WorkspaceSchema, 'The new workspace'),
        ...errors(400, 401, 403, 409, 502, 503),
      },
    }),
    ((c: AnyHandler) => createWorkspace(c)) as AnyHandler,
  );

  workspacesRootApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}',
      tags: ['workspaces'],
      summary: 'Get a workspace',
      description:
        'The workspace record, the caller’s `role`, its `state` and the `workspace` settings block. `current` names the workspace of a workspace-bound key.',
      ...auth,
      middleware: [supabaseAuth] as const,
      request: { params: WorkspaceIdParam },
      responses: { 200: json(WorkspaceSchema, 'The workspace'), ...errors(401, 409), ...NotFound },
    }),
    ((c: AnyHandler) => readWorkspace(c)) as AnyHandler,
  );

  workspacesRootApp.openapi(
    createRoute({
      method: 'patch',
      path: '/{workspaceId}',
      tags: ['workspaces'],
      summary: 'Update a workspace',
      description:
        'Changes `name`, `icon`, `icon_glyph`, `default_branch`, `manifest_path` or `secret_default_strategy`. A key of the `workspace` settings block answers 400 `workspace_setting_read_only` with `field` and `writer` (the route that writes it) before anything is written.',
      ...auth,
      middleware: [supabaseAuth] as const,
      request: {
        params: WorkspaceIdParam,
        body: {
          content: {
            'application/json': {
              schema: lenientBody({
                name: z.string().optional().openapi({ description: 'New workspace name.' }),
                icon: z.string().optional().openapi({ description: 'Icon name. null clears it.' }),
                icon_glyph: z.string().optional().openapi({ description: 'Icon glyph. null clears it.' }),
                default_branch: z.string().optional().openapi({ description: 'New default branch.' }),
                manifest_path: z.string().optional().openapi({ description: 'New manifest path.' }),
                secret_default_strategy: z.enum(['runtime', 'egress', 'broker', 'denied']).optional().openapi({
                  description: 'How a secret with no strategy of its own reaches a session.',
                }),
              }),
            },
          },
        },
      },
      responses: { 200: json(WorkspaceSchema, 'The updated workspace'), ...errors(400, 401, 403, 409), ...NotFound },
    }),
    ((c: AnyHandler) => patchWorkspace(c)) as AnyHandler,
  );
}
