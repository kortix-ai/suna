/**
 * Finish a connect the human walked away from.
 *
 * The hosted authorization page runs in a popup on the provider's origin and
 * cannot call back into us, so the browser polls `/finalize` to learn the
 * account landed — and that poll is what persists the credential and tells the
 * waiting agent. Close the modal and the poll dies with it: the human finishes
 * Google, sees nothing happen, and the agent sits there having been told
 * nothing.
 *
 * Pipedream never fully had this problem because its connect webhook lands the
 * credential server-side regardless of the browser. Composio has no such
 * webhook wired, so the browser was the ONLY completion path for it.
 *
 * This is the server-side half: a bounded poll started when the link is opened,
 * on the same schedule the browser uses, that finalizes and notifies whether or
 * not anyone is still watching. The browser poll stays primary — it is what
 * makes the open modal feel instant; this only catches what it drops.
 *
 * Deliberately in-process and best-effort, matching the redundancy role the
 * Pipedream webhook already plays. It is NOT a durable job: a deploy mid-window
 * loses the watch, and the next `/finalize` from any surface still settles it.
 * The notification itself is de-duplicated in the database
 * (`enqueueContinueSessionCommand` idempotency key), so this racing the browser
 * cannot produce two prompts.
 */
import { notifyConnectorSession } from '../connectors/notify-session';

const POLL_INTERVAL_MS = 5_000;
const WINDOW_MS = 5 * 60_000;

/** One watch per connector per project — reopening the link must not stack them. */
const active = new Set<string>();

export interface ConnectorCompletionWatch {
  projectId: string;
  slug: string;
  app: string;
  /** Session that minted the link, or null when nobody is waiting on it. */
  sid: string | null;
  uid: string | null;
  /** Injected in tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

export function watchConnectorCompletion(input: ConnectorCompletionWatch): void {
  // Nothing to tell anyone. The credential still lands through the browser poll
  // or the next finalize; there is just no agent waiting on the answer.
  if (!input.sid) return;
  const key = `${input.projectId}:${input.slug}`;
  if (active.has(key)) return;
  active.add(key);
  void runWatch(input, key).catch(() => {
    /* best-effort by construction — never surface into the connect response */
  });
}

async function runWatch(input: ConnectorCompletionWatch, key: string): Promise<void> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? defaultSleep;
  const startedAt = now();
  try {
    const { dbConnectorRouterDeps } = await import('../connectors/db-deps');
    while (now() - startedAt < WINDOW_MS) {
      await sleep(POLL_INTERVAL_MS);
      let connected = false;
      try {
        const result = await dbConnectorRouterDeps.connectorFinalize?.(
          input.projectId,
          input.slug,
          input.uid ?? '',
          undefined,
        );
        connected = result?.connected === true;
      } catch {
        // A provider blip is not a verdict. Keep asking until the window closes.
        continue;
      }
      if (!connected) continue;
      await notifyConnectorSession(input.sid!, input.projectId, input.uid, input.slug, input.app);
      return;
    }
  } finally {
    active.delete(key);
  }
}

/** Exported for tests: is a watch running for this connector? */
export function connectorCompletionWatchActive(projectId: string, slug: string): boolean {
  return active.has(`${projectId}:${slug}`);
}
