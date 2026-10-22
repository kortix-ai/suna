import { refreshAccessControlCache } from '../shared/access-control-cache';

const REFRESH_INTERVAL_MS = 60_000;

const globalForAccessControl = globalThis as typeof globalThis & {
  __kortixAccessControlRefreshTimer?: ReturnType<typeof setInterval> | null;
};

let refreshTimer: ReturnType<typeof setInterval> | null = null;

export function startAccessControlCache() {
  if (globalForAccessControl.__kortixAccessControlRefreshTimer) {
    clearInterval(globalForAccessControl.__kortixAccessControlRefreshTimer);
  }
  refreshAccessControlCache(); // initial load (fire-and-forget)
  refreshTimer = setInterval(refreshAccessControlCache, REFRESH_INTERVAL_MS);
  globalForAccessControl.__kortixAccessControlRefreshTimer = refreshTimer;
}

export function stopAccessControlCache() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (globalForAccessControl.__kortixAccessControlRefreshTimer) {
    clearInterval(globalForAccessControl.__kortixAccessControlRefreshTimer);
    globalForAccessControl.__kortixAccessControlRefreshTimer = null;
  }
}
