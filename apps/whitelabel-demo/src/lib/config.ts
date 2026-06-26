import 'server-only';

export class WhitelabelSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WhitelabelSetupError';
  }
}

export function getDataDir() {
  return process.env.WHITELABEL_DATA_DIR ?? `${process.cwd()}/.data`;
}

export function getKortixApiUrl() {
  const explicit = process.env.WHITELABEL_KORTIX_API_URL ?? process.env.KORTIX_API_URL;
  if (explicit) return explicit.replace(/\/+$/, '');

  const proxyTarget = process.env.KORTIX_API_PROXY_TARGET;
  if (proxyTarget) return `${proxyTarget.replace(/\/+$/, '')}/v1`;

  return 'http://localhost:8008/v1';
}

export function getKortixToken() {
  return process.env.WHITELABEL_KORTIX_TOKEN ?? '';
}

export function requireKortixToken() {
  const token = getKortixToken();
  if (!token) {
    throw new WhitelabelSetupError(
      'Set WHITELABEL_KORTIX_TOKEN to a Kortix JWT or PAT so the demo server can call the Kortix backend.',
    );
  }
  return token;
}
