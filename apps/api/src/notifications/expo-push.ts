// Expo Push API client (https://docs.expo.dev/push-notifications/sending-notifications/).
//
// Sends in batches of at most 100 messages (the Expo limit per request),
// retries a batch once on a network error or a 5xx, and deletes every token
// whose ticket reports `DeviceNotRegistered`. Every dependency is injectable
// so tests run without the network or a database.
import type { PushDeviceTokenStore } from './device-tokens';

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
export const EXPO_PUSH_BATCH_SIZE = 100;
const DEFAULT_RETRY_DELAY_MS = 1_000;

export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  /** iOS sound file name bundled in the app, or null for no sound. */
  sound: string | null;
  /** Android notification channel id. */
  channelId: string;
  priority: 'high';
}

export type ExpoPushTicket =
  | { status: 'ok'; id: string }
  | { status: 'error'; message?: string; details?: { error?: string } };

export interface ExpoPushOptions {
  fetch?: typeof fetch;
  /** Adds `Authorization: Bearer <token>` when set. */
  accessToken?: string;
  /** Deletes tokens that Expo reports as `DeviceNotRegistered`. */
  store?: Pick<PushDeviceTokenStore, 'deleteTokens'>;
  retryDelayMs?: number;
  endpoint?: string;
  /** Receives failure warnings. Defaults to `console`. */
  logger?: Pick<Console, 'warn'>;
}

export interface ExpoPushResult {
  /** One entry per message that reached Expo, in send order. */
  tickets: { token: string; ticket: ExpoPushTicket }[];
  /** Tokens deleted because Expo reported `DeviceNotRegistered`. */
  removedTokens: string[];
  /** Messages in batches that failed after the retry. */
  failedMessages: number;
}

type BatchOutcome =
  | { kind: 'ok'; tickets: ExpoPushTicket[] }
  | { kind: 'retryable'; reason: string }
  | { kind: 'failed'; reason: string };

async function postBatch(
  batch: readonly ExpoPushMessage[],
  opts: Required<Pick<ExpoPushOptions, 'endpoint'>> & ExpoPushOptions,
): Promise<BatchOutcome> {
  const doFetch = opts.fetch ?? fetch;
  const headers: Record<string, string> = {
    accept: 'application/json',
    'accept-encoding': 'gzip, deflate',
    'content-type': 'application/json',
  };
  if (opts.accessToken) headers.authorization = `Bearer ${opts.accessToken}`;
  let res: Response;
  try {
    res = await doFetch(opts.endpoint, { method: 'POST', headers, body: JSON.stringify(batch) });
  } catch (err) {
    return { kind: 'retryable', reason: err instanceof Error ? err.message : String(err) };
  }
  const text = await res.text().catch(() => '');
  if (res.status >= 500) return { kind: 'retryable', reason: `HTTP ${res.status}` };
  if (!res.ok) return { kind: 'failed', reason: `HTTP ${res.status}: ${text.slice(0, 500)}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'failed', reason: 'response is not JSON' };
  }
  const data = (parsed as { data?: unknown })?.data;
  if (!Array.isArray(data)) return { kind: 'failed', reason: `no ticket array: ${text.slice(0, 500)}` };
  return { kind: 'ok', tickets: data as ExpoPushTicket[] };
}

/** Send `messages` to Expo. Never throws. */
export async function sendExpoPushMessages(
  messages: readonly ExpoPushMessage[],
  options: ExpoPushOptions = {},
): Promise<ExpoPushResult> {
  const opts = { ...options, endpoint: options.endpoint ?? EXPO_PUSH_URL };
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const logger = options.logger ?? console;
  const result: ExpoPushResult = { tickets: [], removedTokens: [], failedMessages: 0 };
  const unregistered: string[] = [];

  for (let start = 0; start < messages.length; start += EXPO_PUSH_BATCH_SIZE) {
    const batch = messages.slice(start, start + EXPO_PUSH_BATCH_SIZE);
    let outcome = await postBatch(batch, opts);
    if (outcome.kind === 'retryable') {
      if (retryDelayMs > 0) await new Promise((r) => setTimeout(r, retryDelayMs));
      outcome = await postBatch(batch, opts);
    }
    if (outcome.kind !== 'ok') {
      result.failedMessages += batch.length;
      logger.warn('[push] expo batch failed', { size: batch.length, reason: outcome.reason });
      continue;
    }
    // Tickets come back in message order.
    batch.forEach((message, i) => {
      const ticket = outcome.tickets[i];
      if (!ticket) return;
      result.tickets.push({ token: message.to, ticket });
      if (ticket.status === 'error') {
        if (ticket.details?.error === 'DeviceNotRegistered') unregistered.push(message.to);
        else logger.warn('[push] expo ticket error', { error: ticket.details?.error, message: ticket.message });
      }
    });
  }

  if (unregistered.length > 0 && options.store) {
    const tokens = [...new Set(unregistered)];
    try {
      await options.store.deleteTokens(tokens);
      result.removedTokens = tokens;
    } catch (err) {
      logger.warn('[push] could not delete unregistered tokens', err instanceof Error ? err.message : err);
    }
  }
  return result;
}
