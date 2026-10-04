export interface DeploymentLogEvent {
  type: string;
  message: string;
  createdAt: Date;
}

export function deploymentEventsAsLogs(
  events: DeploymentLogEvent[],
  after = 0,
  limit = 200,
) {
  const start = Math.max(0, Math.trunc(after));
  const size = Math.max(1, Math.min(1000, Math.trunc(limit)));
  const selected = events.slice(start, start + size);
  return {
    entries: selected.map((event, index) => ({
      cursor: start + index + 1,
      time: event.createdAt.toISOString(),
      source: event.type === 'build_log' ? 'build' : 'kortix',
      line: event.type === 'build_log' ? event.message : `[${event.type}] ${event.message}`,
    })),
    next_cursor: start + selected.length,
  };
}
