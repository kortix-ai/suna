import { discordGateway } from '../../channels/discord/gateway';
import { runWorkerTick } from '../../shared/audit-scope';

let checkTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Leader-only (worker/jobs/index.ts): Discord delivers the bot's messages over
 * one Gateway WebSocket, held by one process. Idle when the Kortix Discord
 * application is not configured. The tick reopens a connection a stop or a
 * fatal close ended; a dropped one reconnects by itself.
 */
export function startDiscordGateway(): void {
  if (checkTimer) return;
  void discordGateway.start();
  checkTimer = setInterval(() => {
    void runWorkerTick('discord-gateway', async () => {
      // A fatal close stays closed until the process restarts (gateway.ts `fatal`).
      if (!discordGateway.connected) await discordGateway.start();
    });
  }, 60_000);
}

/** Saves the session before it closes, so the next leader resumes it (a deploy loses no message). */
export async function stopDiscordGateway(): Promise<void> {
  if (checkTimer) clearInterval(checkTimer);
  checkTimer = null;
  await discordGateway.stop();
}
