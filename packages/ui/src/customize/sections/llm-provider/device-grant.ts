import type { startProjectProviderOAuth, pollProjectProviderOAuth } from '@kortix/sdk';
import type { ChatGptChallenge, ChatGptPhase } from './types';

/** Run the device grant without owning React state or SDK transport. */
export async function runDeviceGrant({
  startOAuth, pollOAuth, sleep, now, isCancelled, setChallenge, setPhase, setError, onSuccess, failedMessage,
}: {
  startOAuth: () => ReturnType<typeof startProjectProviderOAuth>;
  pollOAuth: (flowId: string) => ReturnType<typeof pollProjectProviderOAuth>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  isCancelled: () => boolean;
  setChallenge: (challenge: ChatGptChallenge | null) => void;
  setPhase: (phase: ChatGptPhase) => void;
  setError: (error: string) => void;
  onSuccess: () => void;
  failedMessage: string;
}) {
  try {
    const start = await startOAuth();
    if (isCancelled()) return;
    setChallenge({ url: start.verification_url, code: start.user_code });

    const interval = Math.max(2000, start.interval_ms || 3000);
    const deadline = start.expires_at || now() + 10 * 60_000;
    while (!isCancelled() && now() < deadline) {
      await sleep(interval);
      if (isCancelled()) return;
      let res;
      try {
        res = await pollOAuth(start.flow_id);
      } catch {
        continue;
      }
      if (isCancelled()) return;
      if (res.status === 'success') {
        onSuccess();
        return;
      }
      if (res.status === 'failed') {
        setChallenge(null);
        setPhase('idle');
        setError(res.error || 'Authorization failed');
        return;
      }
      if (res.status === 'expired') {
        setChallenge(null);
        setPhase('idle');
        setError('Authorization timed out. Try again.');
        return;
      }
    }
    if (!isCancelled()) {
      setChallenge(null);
      setPhase('idle');
      setError('Authorization timed out. Try again.');
    }
  } catch (err) {
    if (isCancelled()) return;
    setChallenge(null);
    setPhase('idle');
    setError(err instanceof Error ? err.message : failedMessage);
  }
}
