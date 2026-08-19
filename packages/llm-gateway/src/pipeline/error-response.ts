import type { GatewayAttemptFailure } from '../domain';

export interface GatewayErrorContext {
  message: string;
  code: string;
  upstreamCode?: string | number;
  upstreamStatus?: number;
  provider: string;
  requestedModel: string;
  resolvedModel: string;
  requestId: string;
  suggestion: string;
  attemptFailures?: GatewayAttemptFailure[];
}

function wireAttemptFailure(failure: GatewayAttemptFailure): Record<string, unknown> {
  return {
    attempt: failure.attempt,
    provider: failure.provider,
    route_model: failure.routeModel,
    resolved_model: failure.resolvedModel,
    stage: failure.stage,
    ...(failure.status !== undefined ? { status: failure.status } : {}),
    code: failure.code,
    message: failure.message,
  };
}

// OpenAI-compatible clients read `error.message`; generic HTTP clients commonly
// read top-level `message`/`code`. Keep both so no client has to fall back to the
// unhelpful HTTP status text (for example, "Bad Gateway").
export function gatewayErrorBody(context: GatewayErrorContext): Record<string, unknown> {
  const attemptFailures = context.attemptFailures?.map(wireAttemptFailure);
  const details = {
    message: context.message,
    type: context.code,
    code: context.upstreamCode ?? context.code,
    ...(context.upstreamStatus !== undefined ? { upstream_status: context.upstreamStatus } : {}),
    provider: context.provider,
    requested_model: context.requestedModel,
    resolved_model: context.resolvedModel,
    request_id: context.requestId,
    suggestion: context.suggestion,
    ...(attemptFailures?.length ? { attempt_failures: attemptFailures } : {}),
  };

  return {
    error: details,
    message: context.message,
    code: context.code,
    ...(context.upstreamCode ? { upstream_code: context.upstreamCode } : {}),
    ...(context.upstreamStatus !== undefined ? { upstream_status: context.upstreamStatus } : {}),
    provider: context.provider,
    requested_model: context.requestedModel,
    resolved_model: context.resolvedModel,
    request_id: context.requestId,
    suggestion: context.suggestion,
    ...(attemptFailures?.length ? { attempt_failures: attemptFailures } : {}),
  };
}

export function gatewayErrorResponse(status: number, context: GatewayErrorContext): Response {
  return new Response(JSON.stringify(gatewayErrorBody(context)), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
