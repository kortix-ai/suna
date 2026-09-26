/**
 * The transcript's failure surface.
 *
 * Three different failures reach the reader as one card shape, because the
 * reader's question is always the same: what broke, who broke it, what now.
 *
 *  - `session.sendError` (`KortixSendError`) — the prompt never ran. Billing
 *    (402) gets the "Upgrade plan" line and the parsed detail; a gateway
 *    failure names the provider, the code and the suggestion; a connector
 *    failure names the connectors.
 *  - a per-turn `error` from `classifyTurn` (`TurnError`) — the turn ran and
 *    failed. Same gateway fields.
 *  - `startError` / `failure` when `phase === 'error'` — the sandbox never
 *    came up.
 *
 * The `describe*` functions are pure and exported so the rules are unit tests,
 * not frame assertions.
 */

import type { TurnError } from '@kortix/sdk';
import type { KortixSendError } from '@kortix/sdk/react';

import { clip } from '../../../lib/turn-layout.ts';
import { theme } from '../../../theme.ts';

export interface BannerContent {
  title: string;
  message: string;
  /** Provenance and remedy lines, in reading order. */
  details: string[];
}

function gatewayDetails(gateway: {
  provider?: string;
  code?: string;
  suggestion?: string;
  upstreamStatus?: number;
  requestId?: string;
}): string[] {
  const details: string[] = [];
  const head = [
    gateway.provider ? `provider ${gateway.provider}` : null,
    gateway.code ? `code ${gateway.code}` : null,
    gateway.upstreamStatus ? `status ${gateway.upstreamStatus}` : null,
  ].filter((entry): entry is string => entry !== null);
  if (head.length > 0) details.push(head.join(' · '));
  if (gateway.suggestion) details.push(gateway.suggestion);
  if (gateway.requestId) details.push(`request ${gateway.requestId}`);
  return details;
}

/** `session.sendError` → what the banner prints. */
export function describeSendError(error: KortixSendError): BannerContent {
  switch (error.kind) {
    case 'billing': {
      const detail = error.billing?.detail?.message;
      return {
        title: 'Out of credits',
        message: error.message,
        details: [
          'Upgrade plan to continue.',
          ...(detail && detail !== error.message ? [detail] : []),
          ...(error.billing?.status ? [`HTTP ${error.billing.status}`] : []),
        ],
      };
    }
    case 'connector':
      return {
        title: 'Connector not connected',
        message: error.message,
        details: (error.connectors ?? []).map(
          (connector) => `${connector.name} (${connector.authorization_strategy})`,
        ),
      };
    case 'runtime-not-ready':
      return { title: 'Sandbox not ready', message: error.message, details: [] };
    default:
      return {
        title: 'Send failed',
        message: error.message,
        details: error.gateway ? gatewayDetails(error.gateway) : [],
      };
  }
}

/** A turn's normalized `info.error` → what the banner prints. */
export function describeTurnError(error: TurnError): BannerContent {
  return {
    title: error.name === 'Error' ? 'Turn failed' : error.name,
    message: error.message,
    details: gatewayDetails(error),
  };
}

/** A terminal `/start` failure → what the banner prints. */
export function describeStartError(
  startError: unknown,
  failure: { code?: string; message?: string } | null,
): BannerContent {
  const message =
    failure?.message ??
    (startError instanceof Error ? startError.message : String(startError ?? 'unknown'));
  return {
    title: 'Session failed to start',
    message,
    details: failure?.code ? [`code ${failure.code}`] : [],
  };
}

export interface ErrorBannerProps {
  content: BannerContent;
  width: number;
}

export function ErrorBanner({ content, width }: ErrorBannerProps) {
  const body = Math.max(width - 4, 10);
  return (
    <box
      flexDirection="column"
      border
      borderStyle="single"
      borderColor={theme.danger}
      paddingLeft={1}
      paddingRight={1}
      width={Math.max(width, 12)}
    >
      <text fg={theme.danger}>{clip(content.title, body)}</text>
      <text fg={theme.fg} wrapMode="word" width={body}>
        {content.message}
      </text>
      {content.details.map((detail) => (
        <text key={detail} fg={theme.dim}>
          {clip(detail, body)}
        </text>
      ))}
    </box>
  );
}
