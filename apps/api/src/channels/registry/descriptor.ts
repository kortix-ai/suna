/**
 * Connector provider descriptor — the single contract every channel provider
 * (Slack, Teams, Email, Meet) plugs into so the HTTP + SDK surface can stay
 * generic. This is the "plugin" seam: adding a new channel means adding one
 * descriptor to the registry, not a new tree of bespoke routes.
 *
 * The data model already treats channels as connectors (`executor_connectors`
 * has `providerType='channel'`; `RESERVED_SLUG_PROVIDERS` maps the built-in
 * slugs). What was missing was a uniform *surface* over the per-provider
 * onboarding + runtime differences. A descriptor captures exactly those
 * differences behind a fixed shape:
 *
 *   - lifecycle  → getMode / getInstallation / connect / disconnect (uniform)
 *   - onboarding → the connect() body is provider-specific but funnels through
 *     one route; OAuth-style providers expose a `finalize` capability.
 *   - runtime    → `capabilities`, a name→handler map (slack.uploadFile,
 *     meet.speak, …) reached through one generic dispatch route.
 *
 * The generic route (see routes/connectors-channels.ts) owns auth, project
 * loading, and error→status translation. Descriptors own behavior only.
 */
import type { Context } from 'hono';
import type { ChannelPlatform } from '../../projects/connectors';

/**
 * Project + request context handed to every descriptor method. The generic
 * route resolves and validates this once (membership + capability gate) before
 * dispatching, so descriptors never re-check auth or re-load the project.
 */
export interface ChannelContext {
  projectId: string;
  accountId: string;
  /** The acting user id (for created_by attribution). */
  userId: string;
  /** Project display name — used as a default inbox/bot label. */
  projectName: string | null;
  /** Raw project metadata blob — carries the experimental-feature flags. */
  metadata: unknown;
  /** The inbound request URL — some providers derive webhook callback URLs from it. */
  requestUrl: string;
}

/**
 * Thrown by a descriptor to return a non-200 with an explicit status + JSON
 * body, preserving the exact status codes the old bespoke handlers returned
 * (400/403/409/502/503/504). The generic route catches it and renders
 * `c.json(body, status)`. Anything else thrown becomes a 500.
 */
export class ChannelError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body.error === 'string' ? body.error : `channel error ${status}`);
    this.name = 'ChannelError';
    this.status = status;
    this.body = body;
  }
}

/**
 * A capability handler returns either a plain JSON-serializable value (the
 * common case — the generic route wraps it in `c.json(...)`) or a ready hono
 * `Response` for the odd binary paths (Slack file download/upload proxy) that
 * must set their own content-type/stream. Handlers receive the parsed input
 * and the raw context for those escape hatches.
 */
export type CapabilityResult = unknown | Response;

/**
 * Auth lane for a capability, mapping 1:1 onto what the equivalent old bespoke
 * route required (so nothing regresses):
 *   - 'member'    → project membership only (loadProjectForUser 'read'); no leaf.
 *   - 'write'     → membership + PROJECT_CONNECTOR_WRITE.
 *   - 'customize' → membership + PROJECT_CUSTOMIZE_WRITE (meet name/voice).
 *   - 'session'   → a project-scoped sandbox token OR membership, and NO
 *                   connector.write leaf. The in-sandbox agent path (bind-thread)
 *                   authenticates with its sandbox token; forcing it through
 *                   'write' would lock the agent out entirely.
 */
export type CapabilityAccess = 'member' | 'write' | 'customize' | 'session';

export interface ChannelCapability {
  /** HTTP method the generic dispatch route should accept for this action. */
  method: 'get' | 'post' | 'put' | 'delete';
  /** Auth lane — see CapabilityAccess. Preserves each old route's exact gate. */
  access: CapabilityAccess;
  /** Invoke the capability. `input` is the parsed JSON body (POST/PUT) or query map (GET). */
  handler(ctx: ChannelContext, input: unknown, c: Context): Promise<CapabilityResult>;
}

export interface ConnectorProviderDescriptor {
  /** Provider/platform key — the `platform` on a `provider='channel'` connector. */
  platform: ChannelPlatform;
  /** Human label (e.g. "Slack", "AgentMail Email"). */
  label: string;
  /** The reserved connector slug the built-in materializes under (kortix_slack, …). */
  reservedSlug: string;
  /** Default profile slug when a request omits one. */
  defaultSlug: string;
  /** Channels are inbound surfaces; kept explicit for the unified UI/SDK. */
  direction: 'inbound';

  /**
   * Whether this provider is usable for the project. Encapsulates the
   * experimental-feature gate (email → `agentmail_email`, meet → `meet`);
   * Slack is always available. When false the generic route 403s writes and
   * returns null for reads, matching today's behavior.
   */
  isEnabled(metadata: unknown): boolean;

  /**
   * GET .../mode — onboarding capabilities for the UI (OAuth availability,
   * install URL, whether a managed key is configured). Shape is provider-defined.
   */
  getMode(ctx: ChannelContext): Promise<unknown>;

  /**
   * GET .../installation — the current install summary for `slug`, or null.
   */
  getInstallation(ctx: ChannelContext, slug: string): Promise<unknown | null>;

  /**
   * POST .../connect — provision/attach the install for `slug` from the
   * provider-specific `body`. Returns the install summary. Throws ChannelError
   * for provider failures (bad key, upstream 4xx/5xx, inbox-limit, …).
   */
  connect(ctx: ChannelContext, slug: string, body: unknown): Promise<unknown>;

  /**
   * DELETE .../installation — tear down the install for `slug` and reconcile
   * the connector row away.
   */
  disconnect(ctx: ChannelContext, slug: string): Promise<void>;

  /**
   * Runtime actions beyond the lifecycle — Slack file up/download + thread
   * bind, Meet voices/name/preview/speak, email sender-policy update. Reached
   * via one generic dispatch route: `.../connectors/{slug}/actions/{action}`.
   */
  capabilities: Record<string, ChannelCapability>;
}
