/**
 * The provider-generic device-code (RFC 8628) flow contract — docs/specs/
 * 2026-07-22-unified-auth-gateway.md §6.3. A `DeviceFlowAdapter` is everything
 * the shared `/oauth-credentials/:providerId/*` routes need to run one
 * provider's device grant WITHOUT knowing anything provider-specific: the
 * routes seal/open the opaque handle (`flow-state.ts`), gate on capabilities,
 * and persist via `credential-store.ts`; the adapter supplies only the two
 * network steps (`start`/`poll`) and the display-expiry parse.
 *
 * Today only OpenAI Codex is registered (the one device-code provider with an
 * existing `HarnessAuthKind`). GitHub Copilot / xAI adapters slot in here in
 * Phase 2 (spec §7/§11#4) once `harnesses.ts` gains their kinds — the routes
 * need zero change to gain them, exactly the extensibility the mandate asked
 * for.
 */
import { openAiCodexDeviceAdapter } from './openai-codex';

export interface DeviceFlowStartResult {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
}

export type DeviceFlowPollResult =
  | { status: 'pending' }
  | { status: 'failed'; error: string }
  | { status: 'authorized'; authJson: string };

export interface DeviceFlowAdapter {
  /** The `auth/registry.ts` provider id this adapter serves (e.g. `'openai'`). */
  providerId: string;
  /** The `project_secrets` name the resulting credential is persisted under. */
  secretName: string;
  /** Step 1 — request a device code. */
  start(): Promise<DeviceFlowStartResult>;
  /** Steps 2+3 — one poll tick: still pending, failed, or fully authorized. */
  poll(input: { deviceAuthId: string; userCode: string }): Promise<DeviceFlowPollResult>;
  /** Display-only remaining-ms from the stored credential value. */
  expiresInMs(storedValue: string): number | null;
}

const DEVICE_FLOW_ADAPTERS: Record<string, DeviceFlowAdapter> = {
  [openAiCodexDeviceAdapter.providerId]: openAiCodexDeviceAdapter,
};

/** The device-code adapter for `providerId`, or `undefined` if none is wired. */
export function deviceFlowAdapter(providerId: string): DeviceFlowAdapter | undefined {
  return DEVICE_FLOW_ADAPTERS[providerId];
}
