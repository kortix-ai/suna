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
}

// OpenAI-compatible clients read `error.message`; generic HTTP clients commonly
// read top-level `message`/`code`. Keep both so no client has to fall back to the
// unhelpful HTTP status text (for example, "Bad Gateway").
export function gatewayErrorBody(context: GatewayErrorContext): Record<string, unknown> {
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
  };
}

export function gatewayErrorResponse(status: number, context: GatewayErrorContext): Response {
  return new Response(JSON.stringify(gatewayErrorBody(context)), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
