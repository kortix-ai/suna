/**
 * OpenAI Codex (ChatGPT Plus/Pro) device-code adapter — docs/specs/2026-07-
 * 22-unified-auth-gateway.md §6.3/§10.1. Wraps the already-shipped, unchanged
 * `projects/codex-device-auth.ts` device grant (`startCodexDeviceAuth` /
 * `pollCodexDeviceAuth`) behind the provider-generic {@link DeviceFlowAdapter}
 * contract so the new `/oauth-credentials/:providerId/*` routes drive Codex
 * through the SAME underlying HTTPS calls the old `/oauth/openai/*` routes do —
 * no behavioral change to the Codex device grant itself, only a generalized
 * shell around it (Codex compatibility, Step 3).
 *
 * The stored credential is the OpenCode-shaped `auth.json`
 * (`{ openai: { type:'oauth', access, refresh, expires, accountId } }`) that
 * sandboxes materialize on boot — persisted under `CODEX_AUTH_JSON`, the exact
 * secret name `credentials/codex.ts` reads back for resolution/refresh.
 */
import { pollCodexDeviceAuth, startCodexDeviceAuth } from '../../../projects/codex-device-auth';
import { CODEX_AUTH_JSON_SECRET_NAME } from '../../../projects/lib/serializers';
import { oauthAuthExpiresInMs } from './credential-store';
import type { DeviceFlowAdapter } from './device-flow';

export const openAiCodexDeviceAdapter: DeviceFlowAdapter = {
  providerId: 'openai',
  secretName: CODEX_AUTH_JSON_SECRET_NAME,
  async start() {
    const challenge = await startCodexDeviceAuth();
    return {
      deviceAuthId: challenge.deviceAuthId,
      userCode: challenge.userCode,
      verificationUrl: challenge.verificationUrl,
      intervalMs: challenge.intervalMs,
    };
  },
  poll(input) {
    return pollCodexDeviceAuth(input);
  },
  expiresInMs(storedValue) {
    return oauthAuthExpiresInMs(storedValue);
  },
};
