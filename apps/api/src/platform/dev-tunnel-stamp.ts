/**
 * Which dev tunnel a box calls back to. Local stacks (`pnpm dev`, worktrees)
 * front the API with a Cloudflare quick tunnel, and each start, or a watchdog
 * rotation after the tunnel died, mints a new URL. A box reads
 * `KORTIX_API_URL` once, at create (`providers/platinum.ts`
 * `provisionFromTemplate`): a start sends no env, and the prompt env sync
 * refreshes the LLM gateway URL but not this one. So a box an earlier tunnel
 * created takes prompts (the API reaches it through the provider) and never
 * answers: its replies, connector calls and turn reports go to the dead tunnel.
 *
 * The box row keeps its tunnel in `config.devTunnelUrl`; a delivery to a box
 * of another tunnel answers `no-session` (session-lifecycle/continue-session.ts),
 * so a channel starts the conversation over in a new session, on a new box.
 * Deployed environments have one stable URL: nothing is stamped or read there.
 */
import { config } from '../config';

export const DEV_TUNNEL_URL_KEY = 'devTunnelUrl';

const tunnelUrl = (kortixUrl: string) => kortixUrl.replace(/\/+$/, '');

function isQuickTunnel(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().endsWith('.trycloudflare.com');
  } catch {
    return false;
  }
}

/** The stamp a box created now keeps: its quick tunnel, else nothing (a stable URL). */
export function devTunnelStamp(kortixUrl = config.KORTIX_URL): Record<string, string> {
  const url = tunnelUrl(kortixUrl);
  return isQuickTunnel(url) ? { [DEV_TUNNEL_URL_KEY]: url } : {};
}

/** This stack runs on a quick tunnel: a box's stamp is worth reading. */
export const onDevTunnel = (kortixUrl = config.KORTIX_URL) => isQuickTunnel(tunnelUrl(kortixUrl));

/**
 * Why a box cannot answer, or null: on a quick-tunnel stack, a box stamped
 * with another tunnel. A box without the stamp predates it and is let through.
 */
export function staleDevTunnelReason(boxConfig: unknown, kortixUrl = config.KORTIX_URL): string | null {
  if (!onDevTunnel(kortixUrl)) return null;
  const created = (boxConfig as Record<string, unknown> | null)?.[DEV_TUNNEL_URL_KEY];
  if (typeof created !== 'string' || created === tunnelUrl(kortixUrl)) return null;
  return (
    `This session's sandbox was created by an earlier dev stack run, under the tunnel ${created}. ` +
    `It calls that tunnel for every reply, and the tunnel is gone. Start a new session.`
  );
}
