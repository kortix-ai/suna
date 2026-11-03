/** Discord READY supplies a regional resume host; never trust it as an arbitrary URL. */
export function discordResumeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'wss:' || !url.hostname.endsWith('.discord.gg') || url.username || url.password || url.port) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Reject malformed HELLO values before they reach Node's signed 32-bit timers. */
export function discordHeartbeatInterval(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1000 && value <= 120000
    ? value
    : 41250;
}
