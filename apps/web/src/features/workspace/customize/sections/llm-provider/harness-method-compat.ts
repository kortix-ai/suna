/**
 * Pure auth-kind -> compatible-harnesses data (DISC-08 extraction). No React,
 * no component imports — just the `@kortix/shared` harness descriptor and SDK
 * types, so pure view-model modules (e.g. `runtime-view-model.ts`) can depend
 * on it without transitively pulling in `connect-model-modal.tsx`.
 */

import { HARNESS_IDS, HARNESSES } from '@kortix/shared/harnesses';
import type { HarnessAuthKind, HarnessId } from '@kortix/sdk/projects-client';

// Every auth kind the connect flow knows about. This enumeration is the auth
// method surface (connect-model-modal's ConnectMethod + the native-config /
// managed-gateway rows), not harness identity — only the harness-id
// membership per kind is derived from the canonical descriptor below.
const AUTH_KINDS: readonly HarnessAuthKind[] = [
  'managed_gateway',
  'claude_subscription',
  'codex_subscription',
  'anthropic_api_key',
  'openai_api_key',
  'openai_compatible',
  'anthropic_compatible',
  'native_config',
];

// 2026-07-15 simplification: Claude Code and Codex are harness-only (their
// subscription, their own provider API key, or the repo's native config) —
// never the Kortix managed gateway, never a custom endpoint. OpenCode and Pi
// keep the full gateway story. Derived from the canonical `@kortix/shared`
// harness descriptor's `authKinds` (inverted: kind -> compatible harnesses,
// in `HARNESS_IDS` order) — do not re-hardcode this mapping, it must stay in
// sync with the server's source of truth
// (apps/api/src/projects/lib/composer-capabilities.ts CONNECTIONS table),
// which derives from the same descriptor. Kinds no harness declares (e.g.
// the parked anthropic_compatible endpoint — a custom Anthropic-protocol
// endpoint whose only consumer was Claude Code custom routing, cut by the
// harness-only simplification) resolve to an empty array; the method row in
// `connect-model-modal.tsx` is hidden accordingly, but the form code stays
// intact.
export const METHOD_COMPATIBLE_HARNESSES: Record<HarnessAuthKind, HarnessId[]> = Object.fromEntries(
  AUTH_KINDS.map((kind) => [kind, HARNESS_IDS.filter((id) => HARNESSES[id].authKinds.includes(kind))]),
) as Record<HarnessAuthKind, HarnessId[]>;
