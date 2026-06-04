/**
 * Executor shared types. The normalized catalog shape every provider produces —
 * the one thing the gateway, discovery, and policy layer all speak.
 *
 * Design reference: RhysSullivan/executor (MIT) — see docs/specs/executor-reference.md.
 * We reimplement on our stack; this mirrors their IR's intent (path / input /
 * output / risk) without their Effect/FumaDB machinery.
 */

/** Risk class, derived from the source's own semantics (GET vs DELETE, query vs mutation, destructiveHint). */
export type Risk = 'read' | 'write' | 'destructive';

/**
 * One normalized tool/action. `path` is RELATIVE to its connector (e.g.
 * `charges.create`); the connector slug is prefixed when stored/called
 * (`stripe.charges.create`). Connector-scoped policies match the relative path.
 */
export interface NormalizedAction {
  /** Connector-relative dotted path, unique within a connector. */
  path: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
  risk: Risk;
  /** Provider invocation metadata — how the gateway actually performs the call. */
  binding: ActionBinding;
}

export type ActionBinding =
  | { kind: 'openapi'; method: string; path: string; server: string | null }
  | { kind: 'graphql'; operation: 'query' | 'mutation'; field: string }
  | { kind: 'mcp'; tool: string }
  | { kind: 'http'; method: string; path: string }
  | { kind: 'pipedream'; app: string; actionKey: string }
  // Generic Connect-Proxy request: hit ANY endpoint of a Pipedream-connected
  // app's API. Pipedream injects the user's credential server-side, so this
  // makes a pipedream connector behave like an openapi/http one — the agent
  // supplies method + full URL + body and reaches the whole API surface.
  | { kind: 'pipedream_proxy'; app: string };

/** A Pipedream component/action (from the Connect API listActions). */
export interface PipedreamActionLike {
  key: string;
  name: string;
  description?: string;
  params?: Array<{ name: string; type: string; required?: boolean; description?: string }>;
}

/** A declared HTTP route (provider=http, from `.kortix/executor/*.http.toml`). */
export interface HttpRouteSpec {
  /** Relative tool path, e.g. `users.get`. */
  name: string;
  method: string;
  /** Path template appended to the connector base_url, e.g. `/users/{id}`. */
  path: string;
  description?: string;
  /** Optional explicit risk override; else derived from method. */
  risk?: Risk;
  inputSchema?: Record<string, unknown> | null;
  outputSchema?: Record<string, unknown> | null;
}

/** Minimal MCP tool shape (from listTools), incl. annotation hints. */
export interface McpToolLike {
  name: string;
  description?: string | null;
  inputSchema?: Record<string, unknown> | null;
  outputSchema?: Record<string, unknown> | null;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  } | null;
}
