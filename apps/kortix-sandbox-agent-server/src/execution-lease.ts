import { logger } from './logger';

export const EXECUTION_HEARTBEAT_INTERVAL_MS = 20_000;
export const EXECUTION_LEASE_TTL_SECONDS = 120;
export interface ExecutionLeaseContext {
  projectId: string;
  sessionId: string;
  token: string;
  apiRoot: string;
}
export interface ExecutionLeaseReporterOptions {
  fetchFn?: typeof fetch;
  heartbeatIntervalMs?: number;
  leaseTtlSeconds?: number;
}

export function executionLeaseContextFromEnv(): ExecutionLeaseContext | null {
  const projectId = process.env.KORTIX_PROJECT_ID?.trim();
  const sessionId = process.env.KORTIX_SESSION_ID?.trim();
  const token = (process.env.KORTIX_SANDBOX_TOKEN || process.env.KORTIX_TOKEN || '').trim();
  const apiUrl = process.env.KORTIX_API_URL?.replace(/\/$/, '');
  if (!projectId || !sessionId || !token || !apiUrl) return null;
  return { projectId, sessionId, token, apiRoot: apiUrl.endsWith('/v1') ? apiUrl : `${apiUrl}/v1` };
}

export class ExecutionLeaseReporter {
  private readonly busySessions = new Set<string>();
  private readonly fetchFn: typeof fetch;
  private readonly heartbeatIntervalMs: number;
  private readonly leaseTtlSeconds: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private providerUrl: string | null = null;
  private providerHeaders: Record<string, string> = {};
  private queue: Promise<void> = Promise.resolve();
  constructor(
    private readonly context: ExecutionLeaseContext,
    options: ExecutionLeaseReporterOptions = {},
  ) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? EXECUTION_HEARTBEAT_INTERVAL_MS;
    this.leaseTtlSeconds = options.leaseTtlSeconds ?? EXECUTION_LEASE_TTL_SECONDS;
  }
  discover(): void {
    this.enqueue('execution_lease_discover');
  }
  markBusy(sessionId: string): void {
    if (!sessionId) return;
    const wasIdle = this.busySessions.size === 0;
    this.busySessions.add(sessionId);
    if (!wasIdle) return;
    this.enqueue('execution_heartbeat');
    this.timer = setInterval(() => this.enqueue('execution_heartbeat'), this.heartbeatIntervalMs);
  }
  markInactive(sessionId: string): void {
    if (!sessionId) return;
    this.busySessions.delete(sessionId);
    if (this.busySessions.size > 0) return;
    this.clearTimer();
    this.enqueue('execution_lease_release');
  }
  replaceBusySessions(sessionIds: string[]): void {
    const wasBusy = this.busySessions.size > 0;
    this.busySessions.clear();
    for (const id of sessionIds.filter(Boolean)) this.busySessions.add(id);
    if (!wasBusy && this.busySessions.size > 0) {
      this.enqueue('execution_heartbeat');
      this.timer = setInterval(() => this.enqueue('execution_heartbeat'), this.heartbeatIntervalMs);
    } else if (wasBusy && this.busySessions.size === 0) {
      this.clearTimer();
      this.enqueue('execution_lease_release');
    }
  }
  close(): void {
    this.clearTimer();
    if (this.busySessions.size > 0) {
      this.busySessions.clear();
      this.enqueue('execution_lease_release');
    }
  }
  async settled(): Promise<void> {
    await this.queue;
  }
  private clearTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  private enqueue(
    kind: 'execution_heartbeat' | 'execution_lease_release' | 'execution_lease_discover',
  ): void {
    this.queue = this.queue
      .then(() => this.send(kind))
      .catch((err) =>
        logger.warn('[execution-lease] reporter failed', { err: (err as Error).message }),
      );
  }
  private async send(
    kind: 'execution_heartbeat' | 'execution_lease_release' | 'execution_lease_discover',
  ): Promise<void> {
    if (kind === 'execution_heartbeat' && this.providerUrl) {
      try {
        await this.fetchFn(`${this.providerUrl}/kortix/health`, {
          headers: {
            ...this.providerHeaders,
            Authorization: `Bearer ${this.context.token}`,
          },
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err) {
        logger.warn('[execution-lease] direct provider touch failed', {
          err: (err as Error).message,
        });
      }
    }
    const response = await this.fetchFn(
      `${this.context.apiRoot}/projects/${encodeURIComponent(this.context.projectId)}/turn-stream`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.context.token}`,
        },
        body: JSON.stringify({
          session_id: this.context.sessionId,
          kind,
          lease_ttl_seconds: this.leaseTtlSeconds,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) throw new Error(`${kind} returned ${response.status}`);
    const body = (await response.json().catch(() => ({}))) as {
      provider_url?: unknown;
      provider_headers?: unknown;
    };
    if (typeof body.provider_url === 'string' && body.provider_url.startsWith('https://'))
      this.providerUrl = body.provider_url.replace(/\/$/, '');
    if (body.provider_headers && typeof body.provider_headers === 'object' && !Array.isArray(body.provider_headers)) {
      this.providerHeaders = Object.fromEntries(
        Object.entries(body.provider_headers as Record<string, unknown>).filter(
          ([name, value]) => name.toLowerCase() !== 'authorization' && typeof value === 'string',
        ),
      ) as Record<string, string>;
    }
  }
}
