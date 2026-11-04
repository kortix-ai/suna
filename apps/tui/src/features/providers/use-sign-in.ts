/**
 * One subscription sign-in at a time, the web's contract
 * (`account-secret-resources-panel.tsx` `useChatGptAuthorization` /
 * `useClaudeAuthorization`): a newer start, a cancel or an unmount bumps the
 * generation, so a stale poll never updates a later screen.
 *
 * - ChatGPT and OpenCode: a device code. The SDK's `runProjectProviderOAuthFlow`
 *   starts it, hands back the code and the link, and polls until it lands.
 * - Claude: the server runs `claude setup-token`; the member approves on
 *   claude.com and pastes the code it shows (`submitCode`).
 */

import {
  type ConnectorSharing,
  completeClaudeSubscriptionLogin,
  runProjectProviderOAuthFlow,
  startClaudeSubscriptionLogin,
} from '@kortix/sdk';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface SignInTarget {
  /** The name of a new account. */
  resourceLabel?: string;
  sharing?: ConnectorSharing;
  /** Reconnect this account in place. */
  resourceId?: string;
}

export type SignInPhase = 'idle' | 'starting' | 'waiting' | 'checking' | 'finishing';

export interface SignInState {
  phase: SignInPhase;
  /** Where to sign in. */
  url: string | null;
  /** The device code to enter. Null for Claude. */
  code: string | null;
  error: string | null;
}

const IDLE: SignInState = { phase: 'idle', url: null, code: null, error: null };

export interface UseSignIn {
  state: SignInState;
  /** Resolves once the account is stored, or with false. */
  start(input: { kind: 'device'; provider: string } | { kind: 'claude' }, target: SignInTarget): Promise<boolean>;
  /** Claude: the code claude.com showed. */
  submitCode(code: string): Promise<void>;
  cancel(): void;
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function useSignIn(projectId: string): UseSignIn {
  const generation = useRef(0);
  const [state, setState] = useState<SignInState>(IDLE);
  const claudeFlow = useRef<{ flowId: string; generation: number; resolve(ok: boolean): void } | null>(null);

  const settleClaude = (ok: boolean) => {
    claudeFlow.current?.resolve(ok);
    claudeFlow.current = null;
  };

  useEffect(
    () => () => {
      generation.current += 1;
      settleClaude(false);
    },
    [],
  );

  const cancel = useCallback(() => {
    generation.current += 1;
    settleClaude(false);
    setState(IDLE);
  }, []);

  const start = useCallback<UseSignIn['start']>(
    async (input, target) => {
      settleClaude(false);
      const current = ++generation.current;
      const live = () => current === generation.current;
      setState({ phase: 'starting', url: null, code: null, error: null });

      if (input.kind === 'claude') {
        try {
          const started = await startClaudeSubscriptionLogin(projectId, target);
          if (!live()) return false;
          setState({ phase: 'waiting', url: started.authorize_url, code: null, error: null });
          return await new Promise<boolean>((resolve) => {
            claudeFlow.current = { flowId: started.flow_id, generation: current, resolve };
          });
        } catch (error) {
          if (live()) setState({ ...IDLE, error: message(error, 'Could not start the Claude sign-in. Try again.') });
          return false;
        }
      }

      try {
        const result = await runProjectProviderOAuthFlow({
          projectId,
          provider: input.provider,
          input: target,
          isCancelled: () => !live(),
          onChallenge: (challenge) => {
            if (live()) setState({ phase: 'waiting', url: challenge.verification_url, code: challenge.user_code, error: null });
          },
        });
        if (!live() || result.status === 'cancelled') return false;
        if (result.status === 'success') {
          setState({ phase: 'finishing', url: null, code: null, error: null });
          return true;
        }
        setState({
          ...IDLE,
          error: result.status === 'failed' ? result.error : 'Authorization timed out. Try again.',
        });
        return false;
      } catch (error) {
        if (live()) setState({ ...IDLE, error: message(error, 'Authorization failed. Try again.') });
        return false;
      }
    },
    [projectId],
  );

  const submitCode = useCallback(
    async (code: string) => {
      const flow = claudeFlow.current;
      if (!flow || !code.trim()) return;
      setState((current) => ({ ...current, phase: 'checking', error: null }));
      try {
        await completeClaudeSubscriptionLogin(projectId, { flowId: flow.flowId, code: code.trim() });
        if (flow.generation !== generation.current) return;
        setState({ phase: 'finishing', url: null, code: null, error: null });
        settleClaude(true);
      } catch (error) {
        if (flow.generation !== generation.current) return;
        // A refused code ends the sign-in: the next try signs in again.
        setState({
          ...IDLE,
          error: message(error, 'Could not connect Claude with that code. Sign in again and paste the new code.'),
        });
        settleClaude(false);
      }
    },
    [projectId],
  );

  return { state, start, submitCode, cancel };
}
