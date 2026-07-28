import { logger as appLogger } from '../../lib/logger';
import type { NangoRequestObservation } from './client';

export type NangoTelemetryScope = 'account' | 'managed' | 'webhook';

export interface NangoTelemetryLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export function createNangoRequestObserver(
  scope: NangoTelemetryScope,
  logger: NangoTelemetryLogger = appLogger,
): (observation: NangoRequestObservation) => void {
  return (observation) => {
    const fields = {
      event: 'nango_request',
      provider: 'github',
      credential_source: 'nango',
      scope,
      operation: observation.operation,
      outcome: observation.outcome,
      latency_ms: Math.max(0, Math.trunc(observation.latencyMs)),
      ...(observation.upstreamStatus !== undefined
        ? { upstream_status: observation.upstreamStatus }
        : {}),
      ...(observation.errorCode ? { error_code: observation.errorCode } : {}),
    };
    const write = observation.outcome === 'error' ? logger.warn : logger.info;
    write('Nango request completed', fields);
  };
}

export function recordGithubCredentialState(
  observation: {
    scope: 'account' | 'managed';
    state: 'connected' | 'needs_reconnect' | 'error' | 'disconnected' | 'missing';
    outcome: 'success' | 'error';
    errorCode?: string;
  },
  logger: NangoTelemetryLogger = appLogger,
): void {
  const fields = {
    event: 'github_credential_resolution',
    provider: 'github',
    credential_source: 'nango',
    scope: observation.scope,
    connection_state: observation.state,
    outcome: observation.outcome,
    ...(observation.errorCode ? { error_code: observation.errorCode } : {}),
  };
  const write = observation.outcome === 'error' ? logger.warn : logger.info;
  write('GitHub credential resolution completed', fields);
}

export function recordNangoWebhookResult(
  observation: {
    status: number;
    outcome: 'success' | 'ignored' | 'error';
    errorCode?: string;
  },
  logger: NangoTelemetryLogger = appLogger,
): void {
  const fields = {
    event: 'nango_webhook_result',
    provider: 'github',
    credential_source: 'nango',
    outcome: observation.outcome,
    status: observation.status,
    ...(observation.errorCode ? { error_code: observation.errorCode } : {}),
  };
  const write = observation.outcome === 'error' ? logger.warn : logger.info;
  write('Nango webhook completed', fields);
}
