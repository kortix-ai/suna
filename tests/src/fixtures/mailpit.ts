/**
 * The email a target's Mailpit received (`env.mailpitUrl`: the local stack or a
 * preview). The search is the one the browser lane's inbox helper runs
 * (tests/e2e/helpers/inbox.ts): `to:<address>`, then an exact recipient match.
 */
import { waitFor } from '../core/poll';

export interface MailpitMessage {
  ID: string;
  Subject: string;
  Created: string;
  To?: Array<{ Address?: string }>;
}

/** Every message Mailpit holds for exactly this address. */
export async function mailpitMessagesTo(mailpitUrl: string, address: string): Promise<MailpitMessage[]> {
  const url = new URL(`${mailpitUrl.replace(/\/+$/, '')}/api/v1/search`);
  url.searchParams.set('query', `to:${address}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Mailpit search for ${address} returned ${res.status}`);
  const { messages = [] } = (await res.json()) as { messages?: MailpitMessage[] };
  const wanted = address.toLowerCase();
  return messages.filter((message) => message.To?.some((to) => to.Address?.toLowerCase() === wanted));
}

/** Polls the address's messages until `until` holds, for up to 15 s. */
export function waitForMailpit(
  mailpitUrl: string,
  address: string,
  until: (messages: MailpitMessage[]) => boolean,
): Promise<MailpitMessage[]> {
  return waitFor(() => mailpitMessagesTo(mailpitUrl, address), {
    until,
    timeoutMs: 15_000,
    intervalMs: 500,
    description: `Mailpit mail to ${address}`,
  });
}
