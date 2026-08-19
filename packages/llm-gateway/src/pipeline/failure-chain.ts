import type { GatewayAttemptFailure, GatewayAttemptFailureStage } from '../domain';
import {
  extractUpstreamErrorDetail,
  normalizeUpstreamErrorCode,
  parseUpstreamErrorBody,
} from '../http/parse-upstream-error';
import type { SseErrorFrame } from '../usage';

const MAX_FAILURE_MESSAGE_CHARS = 500;
const MAX_FAILURE_CODE_CHARS = 120;
const MAX_COMPOSITE_MESSAGE_CHARS = 2_000;

export interface AttemptFailureInput {
  provider: string;
  routeModel: string;
  resolvedModel?: string;
  stage: GatewayAttemptFailureStage;
  status?: number;
  code: string | number;
  message: string;
}

function boundedMessage(message: string): string {
  const normalized = message.trim() || 'Upstream candidate failed';
  return normalized.length <= MAX_FAILURE_MESSAGE_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_FAILURE_MESSAGE_CHARS - 1)}…`;
}

function boundedCode(code: string | number): string | number {
  if (typeof code === 'number') return Number.isFinite(code) ? code : 'upstream_error';
  const normalized = code.trim() || 'upstream_error';
  return normalized.length <= MAX_FAILURE_CODE_CHARS
    ? normalized
    : normalized.slice(0, MAX_FAILURE_CODE_CHARS);
}

export function appendAttemptFailure(
  chain: GatewayAttemptFailure[],
  input: AttemptFailureInput,
): GatewayAttemptFailure {
  const failure: GatewayAttemptFailure = {
    attempt: chain.length + 1,
    provider: input.provider,
    routeModel: input.routeModel,
    resolvedModel: input.resolvedModel || input.routeModel,
    stage: input.stage,
    ...(input.status !== undefined ? { status: input.status } : {}),
    code: boundedCode(input.code),
    message: boundedMessage(input.message),
  };
  chain.push(failure);
  return failure;
}

/** Prefer the provider's semantic code over its numeric transport status. */
export function errorFrameCode(frame: SseErrorFrame): string | number {
  const upstreamCode = frame.detail?.upstream_code;
  if (typeof upstreamCode === 'string' || typeof upstreamCode === 'number') {
    return normalizeUpstreamErrorCode(upstreamCode, frame.message) ?? upstreamCode;
  }
  const fromData = extractUpstreamErrorDetail(frame.detail?.data);
  if (typeof fromData?.code === 'string' || typeof fromData?.code === 'number') {
    return normalizeUpstreamErrorCode(fromData.code, fromData.message) ?? fromData.code;
  }
  const responseBody = frame.detail?.responseBody;
  if (typeof responseBody === 'string') {
    const fromBody = parseUpstreamErrorBody(responseBody);
    if (typeof fromBody.code === 'string' || typeof fromBody.code === 'number') {
      return normalizeUpstreamErrorCode(fromBody.code, fromBody.message) ?? fromBody.code;
    }
  }
  return (
    normalizeUpstreamErrorCode(frame.code ?? fromData?.code, frame.message) ??
    'upstream_stream_error'
  );
}

export function failureChainMessage(
  chain: readonly GatewayAttemptFailure[],
  fallback: string,
  requestId?: string,
): string {
  const requestPrefix = requestId ? `${requestId}: ` : '';
  if (chain.length === 0) return boundedCompositeMessage(`${requestPrefix}${fallback}`);
  const unique = chain.filter(
    (failure, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.provider === failure.provider &&
          candidate.resolvedModel === failure.resolvedModel &&
          candidate.code === failure.code &&
          candidate.message === failure.message,
      ) === index,
  );
  const summary = unique
    .map(
      (failure) =>
        `${failure.provider}/${failure.resolvedModel} [${[
          failure.status !== undefined ? `HTTP ${failure.status}` : undefined,
          String(failure.code),
        ]
          .filter(Boolean)
          .join(', ')}]: ${failure.message}`,
    )
    .join('; ');
  const subject =
    unique.length === 1 ? 'Upstream candidate failed' : 'All upstream candidates failed';
  return boundedCompositeMessage(`${requestPrefix}${subject}: ${summary}`);
}

function boundedCompositeMessage(message: string): string {
  return message.length <= MAX_COMPOSITE_MESSAGE_CHARS
    ? message
    : `${message.slice(0, MAX_COMPOSITE_MESSAGE_CHARS - 1)}…`;
}

export function failureChainMetadata(
  chain: readonly GatewayAttemptFailure[],
  fallbackRecovered: boolean,
): Record<string, unknown> | undefined {
  if (chain.length === 0) return undefined;
  return {
    attemptCount: chain.length,
    fallbackRecovered,
    codes: chain.map((failure) => String(failure.code)),
    providers: chain.map((failure) => failure.provider),
    contextRejected: chain.some((failure) => failure.code === 'context_length_exceeded'),
    // NOTE: there is deliberately no `probeTimedOut` here any more. A probe
    // timeout stopped being a failure when the deadline became a commit point
    // (see handler.ts), so it can never appear in a failure chain — the field
    // was permanently false and reported "no probe timeouts happened" whether
    // or not any had. Reintroduce it only alongside a failure mode that can
    // actually produce the code.
  };
}

/**
 * Select the client-visible code after every route candidate is exhausted.
 *
 * Context overflow takes precedence over later fallback failures. OpenCode
 * uses `error.code === "context_length_exceeded"` to start automatic
 * compaction. Replacing that code with a later timeout's generic classification
 * turns a recoverable overflow into an ordinary retry loop.
 */
export function exhaustedRouteErrorCode(
  chain: readonly GatewayAttemptFailure[],
): 'context_length_exceeded' | 'upstream_error' | 'empty_completion' {
  if (chain.some((failure) => failure.code === 'context_length_exceeded')) {
    return 'context_length_exceeded';
  }
  return chain.some((failure) => failure.code !== 'empty_completion')
    ? 'upstream_error'
    : 'empty_completion';
}
