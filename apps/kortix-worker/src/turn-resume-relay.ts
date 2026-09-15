import { type TurnEndRelayConfig, turnEndUrl } from './turn-end-relay.ts';

export class TurnResumeRejectedError extends Error {}

export function buildTurnResumeRelay(cfg: TurnEndRelayConfig) {
  return async (identity: { opencodeSessionId: string; messageId: string; ownerId: string }): Promise<void> => {
    if (!cfg.apiUrl || !cfg.projectId || !cfg.sessionId || !cfg.kortixToken) return;
    const body = JSON.stringify({ session_id: cfg.sessionId, kind: 'turn_resume',
      opencode_session_id: identity.opencodeSessionId, turn_message_id: identity.messageId, turn_owner_id: identity.ownerId });
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const response = await (cfg.fetch ?? fetch)(turnEndUrl(cfg.apiUrl, cfg.projectId), {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.kortixToken}` },
          body, signal: AbortSignal.timeout(cfg.requestTimeoutMs ?? 10_000),
        });
        if (response.ok) {
          const result = await response.json() as { ok?: boolean; outcome?: string };
          if (result.ok === true && ['resumed', 'already_active'].includes(result.outcome ?? '')) return;
          throw new TurnResumeRejectedError('Control plane rejected turn recovery');
        }
        await response.body?.cancel();
        if (response.status >= 400 && response.status < 500 && ![408, 425, 429].includes(response.status)) {
          throw new TurnResumeRejectedError(`Turn recovery returned HTTP ${response.status}`);
        }
        throw new Error(`Turn recovery returned HTTP ${response.status}`);
      } catch (error) {
        if (error instanceof TurnResumeRejectedError) throw error;
        lastError = error;
      }
      if (attempt < 3) await (cfg.waitMs ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(1000 * (attempt + 1));
    }
    throw new Error('Control plane turn recovery is unavailable', { cause: lastError });
  };
}
