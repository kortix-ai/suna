// Connector calls as code: `runConnector` returns the action's output or throws
// a typed error, `paginateConnector` follows a cursor, and `ConnectorHandle` is
// the per-connector surface `kortix.project(id).connector(slug)` returns.

import { ApiError, type ApiErrorFields } from '../../http/api/errors';
import {
  callConnector,
  type ConnectorAccount,
  type ConnectorArgs,
  type ConnectorAttachmentUploadInput,
  type ConnectorAttachmentUploadResult,
  type ConnectorCallOptions,
  type ConnectorCallResult,
  type ConnectorCatalogEntry,
  type ConnectorResult,
  type ConnectorTool,
} from './connectors';

/** The connector-specific fields of a {@link ConnectorCallError}. */
export interface ConnectorCallErrorFields extends ApiErrorFields {
  reason: string;
  connector: string;
  action: string;
  binding?: string | null;
  upstreamStatus?: number | null;
  retryAfterSeconds?: number | null;
  connectUrl?: string | null;
  hint?: string | null;
  availableAccounts?: string[];
  requestedAccount?: string | null;
}

/**
 * A connector call that did not run, or ran and failed. Thrown by
 * {@link runConnector} and `connector(slug).run`.
 *
 * `code` is the machine reason: `upstream_<status>` when the upstream answered
 * with a failure (`upstream_429`, `upstream_404`), `upstream_error` for a
 * failure the upstream reported inside a 2xx, otherwise the leading
 * `snake_case` token of `reason` (`connector_not_connected`,
 * `account_required`, `credential_not_shared`, `policy_block`,
 * `upstream_timeout`, `computer_offline`, `invalid_json`, …), else
 * `connector_error`. `status` is the HTTP status of the
 * Kortix response (200 for `upstream_error`).
 */
export class ConnectorCallError extends ApiError {
  /** The server's full reason text, e.g. `upstream_timeout: no answer in 60000 ms`. */
  reason: string;
  connector: string;
  action: string;
  /** The binding that ran the call (`openapi`, `mcp`, `composio`, …), or null. */
  binding: string | null;
  /** The upstream HTTP status, or null when no upstream answered. */
  upstreamStatus: number | null;
  /** Seconds to wait before a retry (429/503), or null. */
  retryAfterSeconds: number | null;
  /** `connector_not_connected`: the hosted link a human opens to connect an account. */
  connectUrl: string | null;
  /** The server's remedy, written for a human or an agent. */
  hint: string | null;
  /** `account_required` and a mismatched `account`: the names a retry may use. */
  availableAccounts: string[];
  /** The account the call named, when it named one. */
  requestedAccount: string | null;

  constructor(message: string, fields: ConnectorCallErrorFields) {
    const {
      reason,
      connector,
      action,
      binding,
      upstreamStatus,
      retryAfterSeconds,
      connectUrl,
      hint,
      availableAccounts,
      requestedAccount,
      ...apiFields
    } = fields;
    super(message, { ...apiFields, name: 'ConnectorCallError' });
    this.reason = reason;
    this.connector = connector;
    this.action = action;
    this.binding = binding ?? null;
    this.upstreamStatus = upstreamStatus ?? null;
    this.retryAfterSeconds = retryAfterSeconds ?? null;
    this.connectUrl = connectUrl ?? null;
    this.hint = hint ?? null;
    this.availableAccounts = availableAccounts ?? [];
    this.requestedAccount = requestedAccount ?? null;
  }
}

/**
 * A policy holds the call for a human's approval (HTTP 202). Nothing ran.
 * After approval, the identical call runs; `approvalUrl` is where a human
 * decides.
 */
export class ConnectorApprovalPendingError extends Error {
  connector: string;
  action: string;
  reason: string | null;
  executionId: string | null;
  approvalUrl: string | null;
  approvalSummary: string | null;
  approvalInstructions: string | null;
  /** True when repeating the identical call after approval runs it. */
  retryable: boolean;

  constructor(connector: string, action: string, result: ConnectorCallResult) {
    super(
      `${connector}.${action} is waiting for approval` +
        (result.approval_url ? `: ${result.approval_url}` : ''),
    );
    this.name = 'ConnectorApprovalPendingError';
    this.connector = connector;
    this.action = action;
    this.reason = result.reason ?? null;
    this.executionId = result.execution_id ?? null;
    this.approvalUrl = result.approval_url ?? null;
    this.approvalSummary = result.approval_summary ?? null;
    this.approvalInstructions = result.approval_instructions ?? null;
    this.retryable = result.retryable ?? false;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * {@link paginateConnector} reached `maxPages` and `next` still returned args:
 * the listing is incomplete. Thrown after the last allowed page was consumed.
 * Resume with `paginate(action, error.nextArgs, options)`.
 */
export class ConnectorPageLimitError extends Error {
  readonly code = 'max_pages_exceeded';
  connector: string;
  action: string;
  maxPages: number;
  /** The args of the first page not fetched. */
  nextArgs: Record<string, unknown>;

  constructor(connector: string, action: string, maxPages: number, nextArgs: Record<string, unknown>) {
    super(`${connector}.${action} has more than ${maxPages} pages; resume with nextArgs`);
    this.name = 'ConnectorPageLimitError';
    this.connector = connector;
    this.action = action;
    this.maxPages = maxPages;
    this.nextArgs = nextArgs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

function reasonCode(reason: string): string {
  return /^([a-z][a-z0-9_]*)(?::|$)/.exec(reason)?.[1] ?? 'connector_error';
}

function retryAfterHeader(response: Response | undefined): number | null {
  const value = response?.headers?.get('retry-after');
  return value && /^\d+$/.test(value.trim()) ? Number(value) : null;
}

function toConnectorCallError(error: unknown, connector: string, action: string): unknown {
  if (!(error instanceof ApiError) || typeof error.status !== 'number') return error;
  const body: Record<string, any> =
    error.details && typeof error.details === 'object' ? error.details : {};
  const reason = str(body.reason) ?? str(body.error) ?? error.message;
  const prefixed = /^upstream_(\d{3})\b/.exec(reason);
  const upstreamStatus =
    typeof body.upstream_status === 'number' ? body.upstream_status : prefixed ? Number(prefixed[1]) : null;
  return new ConnectorCallError(str(body.message) ?? str(body.hint) ?? reason, {
    status: error.status,
    // An upstream failure's reason is the upstream's own text (any words), so
    // its code is the upstream status; every other reason is a server slug.
    code: upstreamStatus === null ? reasonCode(reason) : `upstream_${upstreamStatus}`,
    details: error.details,
    data: error.details,
    response: error.response,
    reason,
    connector: str(body.connector) ?? connector,
    action: str(body.action) ?? action,
    binding: str(body.binding),
    upstreamStatus,
    retryAfterSeconds:
      typeof body.retry_after_seconds === 'number'
        ? body.retry_after_seconds
        : retryAfterHeader(error.response),
    connectUrl: str(body.connect_url),
    hint: str(body.hint),
    availableAccounts: Array.isArray(body.available_accounts) ? body.available_accounts : [],
    requestedAccount: str(body.requested_account),
  });
}

/** `output`, or the payload unwrapped client-side from a server that predates it. */
function callOutput(result: ConnectorCallResult): unknown {
  if ('output' in result) return result.output;
  const data = result.data as Record<string, any> | undefined;
  if (data?.provider === 'composio' && 'result' in data) return data.result;
  if (data?.jsonrpc === '2.0' && data.result) return data.result.structuredContent ?? data.result.content;
  return result.data;
}

/**
 * Run `<slug>.<action>` and return its `output`: the payload without the
 * binding's envelope (Composio `result`, MCP `structuredContent ?? content`,
 * GraphQL `data`, otherwise the upstream body).
 *
 * Throws {@link ConnectorApprovalPendingError} when a policy holds the call,
 * and {@link ConnectorCallError} for every other outcome that is not a
 * success, including a failure the upstream reported inside a 2xx. Never
 * retries: a connector call is not idempotent.
 */
export async function runConnector<T = unknown>(
  projectId: string | undefined,
  slug: string,
  action: string,
  args: Record<string, unknown> = {},
  options: ConnectorCallOptions = {},
): Promise<T> {
  const connector = slug.trim();
  const actionPath = action.trim();
  if (!connector || !actionPath) throw new Error('connector slug and action are required');
  let result: ConnectorCallResult;
  try {
    result = await callConnector(projectId, `${connector}.${actionPath}`, args, options);
  } catch (error) {
    throw toConnectorCallError(error, connector, actionPath);
  }
  if (result.status === 'pending_approval') {
    throw new ConnectorApprovalPendingError(connector, actionPath, result);
  }
  if (!result.ok || result.upstream_error) {
    const reason = result.upstream_error ?? result.reason ?? 'connector_error';
    throw new ConnectorCallError(reason, {
      status: 200,
      code: result.upstream_error ? 'upstream_error' : reasonCode(reason),
      details: result,
      data: result,
      reason,
      connector,
      action: actionPath,
      binding: result.binding ?? null,
      upstreamStatus: result.upstream_status ?? null,
    });
  }
  return callOutput(result) as T;
}

export interface ConnectorPaginateOptions<O, A> extends ConnectorCallOptions {
  /**
   * The args of the next page, built from this page's output and args; return
   * `undefined` or `null` after the last page.
   */
  next: (page: O, args: A) => A | null | undefined;
  /**
   * The most pages to fetch. Default 100. When `next` still returns args after
   * the last allowed page, the iterator throws {@link ConnectorPageLimitError}
   * with those args, so a capped listing never reads as complete.
   */
  maxPages?: number;
}

/**
 * Yield the `output` of each page of `<slug>.<action>`. Each page is one
 * {@link runConnector} call with the same options, so a failed page throws the
 * same typed errors. Reaching `maxPages` with more pages left throws
 * {@link ConnectorPageLimitError}.
 */
export async function* paginateConnector<
  O = unknown,
  A extends Record<string, unknown> = Record<string, unknown>,
>(
  projectId: string | undefined,
  slug: string,
  action: string,
  args: A,
  options: ConnectorPaginateOptions<O, A>,
): AsyncGenerator<O, void, undefined> {
  const { next, maxPages = 100, ...callOptions } = options;
  let pageArgs: A | null | undefined = args;
  for (let page = 0; pageArgs; page++) {
    if (page >= maxPages) throw new ConnectorPageLimitError(slug, action, maxPages, pageArgs);
    const output: O = await runConnector<O>(projectId, slug, action, pageArgs, callOptions);
    yield output;
    pageArgs = next(output, pageArgs);
  }
}

/**
 * One connector, bound to a project (`kortix.project(id).connector(slug)`) or
 * to the token's scope (`kortix.connector(slug)`). Args and outputs are typed
 * from {@link ConnectorActionRegistry} when `kortix connectors types` generated
 * it; otherwise args are any object and outputs are `unknown`.
 */
export interface ConnectorHandle<S extends string = string> {
  readonly slug: S;
  /** {@link runConnector}: the action's output, or a typed error. */
  run<A extends string>(
    action: A,
    args: ConnectorArgs<S, A>,
    options?: ConnectorCallOptions,
  ): Promise<ConnectorResult<S, A>>;
  /** The raw call result: 200 and 202 resolve, other statuses throw `ApiError`. */
  call<A extends string>(
    action: A,
    args: ConnectorArgs<S, A>,
    options?: ConnectorCallOptions,
  ): Promise<ConnectorCallResult<unknown, ConnectorResult<S, A>>>;
  /** This connector with every action's input and output schema, or null when not callable. */
  describe(): Promise<ConnectorCatalogEntry | null>;
  /** One action with its input and output schema, or null. */
  describe(action: string): Promise<ConnectorTool | null>;
  /** The accounts this caller may run the connector as, default first. */
  accounts(): Promise<ConnectorAccount[]>;
  /** {@link paginateConnector} over one action. */
  paginate<A extends string>(
    action: A,
    args: ConnectorArgs<S, A>,
    options: ConnectorPaginateOptions<ConnectorResult<S, A>, ConnectorArgs<S, A>>,
  ): AsyncGenerator<ConnectorResult<S, A>, void, undefined>;
  /** Upload bytes for a later call of this connector. */
  uploadAttachment(
    content: Uint8Array | ArrayBuffer | Blob,
    input: Omit<ConnectorAttachmentUploadInput, 'connector'>,
  ): Promise<ConnectorAttachmentUploadResult>;
}
