import type { PromptConnectorVerdict } from './prompt-connector-preflight';

/** One refusal contract for direct runtime requests and durable inbox admission. */
export function promptConnectorRefusalBody(verdict: PromptConnectorVerdict) {
  if (verdict.ok) return null;
  if (verdict.kind === 'unavailable') {
    const message =
      verdict.aliases.length === 1
        ? `Required connection "${verdict.aliases[0]}" is unavailable`
        : `Required connections ${verdict.aliases.map((alias) => `"${alias}"`).join(', ')} are unavailable`;
    return {
      error: message,
      message,
      code: 'REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE',
      connectors: verdict.aliases,
    };
  }
  const message = 'Create the required connections before continuing this session.';
  return {
    error: message,
    message,
    code: 'CONNECTOR_CONNECTION_REQUIRED',
    connector_connections: verdict.connections,
  };
}
