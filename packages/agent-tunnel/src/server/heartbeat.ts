import type { TunnelRelay } from './relay';
import type { HeartbeatConfig } from '../shared/types';

interface HeartbeatState {
  missedPongs: number;
  lastPongAt: number;
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_MISSED = 3;

export class HeartbeatManager {
  private states = new Map<string, HeartbeatState>();
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private relay: TunnelRelay;
  private intervalMs: number;
  private maxMissed: number;

  constructor(relay: TunnelRelay, config?: HeartbeatConfig) {
    this.relay = relay;
    this.intervalMs = config?.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.maxMissed = config?.maxMissed ?? DEFAULT_MAX_MISSED;
  }

  start(): void {
    if (this.intervalHandle) return;

    this.intervalHandle = setInterval(() => this.tick(), this.intervalMs);

    console.log(
      `[tunnel-heartbeat] Started (interval: ${this.intervalMs}ms, max missed: ${this.maxMissed})`,
    );
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.states.clear();
    console.log('[tunnel-heartbeat] Stopped');
  }

  register(tunnelId: string): void {
    this.states.set(tunnelId, {
      missedPongs: 0,
      lastPongAt: Date.now(),
    });
    // Collect the live handler list immediately. Waiting for the first interval
    // can advertise stale DB capabilities for up to 30 seconds after connect.
    this.relay.sendNotification(tunnelId, 'tunnel.ping', {
      timestamp: Date.now(),
    });
  }

  unregister(tunnelId: string): void {
    this.states.delete(tunnelId);
  }

  recordPong(tunnelId: string): void {
    const state = this.states.get(tunnelId);
    if (state) {
      state.missedPongs = 0;
      state.lastPongAt = Date.now();
    }
  }

  private tick(): void {
    for (const [tunnelId, state] of this.states) {
      const sent = this.relay.sendNotification(tunnelId, 'tunnel.ping', {
        timestamp: Date.now(),
      });

      if (!sent) {
        this.states.delete(tunnelId);
        continue;
      }

      state.missedPongs++;

      if (state.missedPongs >= this.maxMissed) {
        console.warn(
          `[tunnel-heartbeat] Agent ${tunnelId} missed ${state.missedPongs} pongs — timing out`,
        );
        this.relay.emitEvent('agent:timeout', { tunnelId });
        this.relay.disconnectAgent(tunnelId, 4000, 'heartbeat timeout');
        this.states.delete(tunnelId);
      }
    }
  }
}
