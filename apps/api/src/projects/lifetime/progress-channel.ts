/**
 * BOUNDED SANDBOX LIFETIME — which progress signal, if any, a box can produce.
 *
 * "Real work burns tokens, so `usage_events` is a universal progress signal" is
 * FALSE, and believing it would have made this design kill every BYOK turn at
 * the turn ceiling while the shadow gate certified it as safe — because
 * `last_usage_age_ms` is null for those boxes BY CONSTRUCTION, and null is
 * indistinguishable from "never did anything".
 *
 *   'gateway'  opencode. Hard-locked to the gateway (`enabled_providers =
 *              ['kortix']`), including on self-host via the in-process gateway.
 *              Always produces usage_events.
 *
 *   'acp'      claude / codex / pi. MAY produce usage_events (managed Codex
 *              routes through /router/openai) or none at all — the harness
 *              registry launches Claude Code with NO ANTHROPIC_BASE_URL when a
 *              direct key is present, and points pi straight at
 *              api.openai.com. Those keys arrive as ordinary project secrets.
 *              But ALL of its traffic transits the API as ACP envelopes, so the
 *              relay signal (W3b) covers it.
 *
 *   'none'     conservative default for anything not positively classified. A
 *              box here is bounded by observed turn starts and by the absolute
 *              run cap only. Even at cap-only that is a 10x improvement on the
 *              264-hour status quo — but it is also the bucket that must be
 *              proved empty (or genuinely dead) in shadow before enforcement
 *              may touch it.
 *
 * Shadow reports and monitors bucket on this AND on harness, so a future
 * harness that produces neither signal shows up as its own bucket rather than
 * as a passing `null`.
 */

import { isHarnessId } from '@kortix/shared/harnesses';

export type ProgressChannel = 'gateway' | 'acp' | 'none';

/**
 * `metadata.runtime_transport` / `runtime_harness` are the session's own record
 * of how it runs. Absent metadata means an older row, which classifies as
 * 'none' — the conservative direction.
 */
export function classifyProgressChannel(
  metadata: Record<string, unknown> | null | undefined,
): ProgressChannel {
  const harness = metadata?.runtime_harness;
  const transport = metadata?.runtime_transport;
  if (harness === 'opencode') return 'gateway';
  if (isHarnessId(harness)) return 'acp';
  if (transport === 'acp') return 'acp';
  // An opencode session predating the harness metadata carries no harness at
  // all but is still gateway-locked; `runtime_transport === 'rest'` is its
  // fingerprint. Anything else stays 'none' rather than being guessed into a
  // bucket that would license a longer life.
  if (transport === 'rest') return 'gateway';
  return 'none';
}
