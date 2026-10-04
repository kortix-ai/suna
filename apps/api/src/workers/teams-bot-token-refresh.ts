import {
  prewarmTeamsBotToken,
  refreshTeamsBotToken,
  teamsConfigured,
  TEAMS_TOKEN_REFRESH_MS,
} from '../services/channels';

let refreshTimer: ReturnType<typeof setInterval> | null = null;

export function startTeamsBotTokenRefresh(): void {
  if (refreshTimer || !teamsConfigured()) return;
  void prewarmTeamsBotToken();
  refreshTimer = setInterval(() => {
    void refreshTeamsBotToken();
  }, TEAMS_TOKEN_REFRESH_MS);
  refreshTimer.unref();
}

export function stopTeamsBotTokenRefresh(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}
