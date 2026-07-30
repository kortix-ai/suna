/**
 * The ONE rule for "does this ACP envelope re-point the session's acting agent?"
 *
 * `session/set_config_option` is the only relayed ACP method that can change WHO
 * runs. Both API edges that forward ACP envelopes must apply the same rule:
 *
 *   - `projects/routes/acp.ts` — the managed ACP route the web/CLI clients use.
 *   - `sandbox-proxy/routes/preview.ts` — `/v1/p/<external_id>/8000/kortix/acp/<id>`,
 *     which reaches the SAME daemon endpoint. It is a full bypass of the route
 *     above, so a guard on only one of them is not a control at all.
 *
 * On OpenCode the `mode` option selects the harness AGENT: the built-ins `build`
 * and `plan`, plus every project agent declared `mode: primary` — which is what
 * a marketplace template installs (packages/starter/templates/marketplace/runtime/agents/*.md
 * ship `mode: primary` and a matching `agents:` block with its own `connectors:`).
 * That harness agent IS the Kortix identity `account_tokens.agent_grant` was
 * minted for, and the connector / Kortix-CLI / secret gates read that row at CALL
 * time (executor/router.ts, iam/engine-v2.ts, secrets/strategy.ts). Relaying a
 * foreign `mode` therefore runs agent B for the rest of the session under agent
 * A's grant — the escalation ./session-token-grant.ts documents.
 *
 * REFUSED rather than re-minted, matching the REST prompt path's existing
 * agent-immutability contract (409 AGENT_SWITCH_REQUIRES_NEW_SESSION): a re-mint
 * can re-scope connectors and CLI powers, but it cannot un-read the secrets agent
 * A already pulled into the box's env file, its shells and its context. The mode
 * also persists for the SESSION, not the turn, so there is no per-turn hook to
 * hang a re-mint on.
 *
 * PER-HARNESS RULE — only OpenCode is policed:
 *   - `opencode` — `mode` is the agent. ENFORCE against the committed one.
 *   - `claude`   — `mode` is the PERMISSION mode (`default`, `acceptEdits`,
 *                  `plan`, `bypassPermissions`). The acting agent is fixed by the
 *                  harness config dir at process launch; no mode value moves it.
 *   - `codex`    — `mode` is the approval preset (`agent`, `agent-full-access`).
 *                  Same reasoning.
 *   - `pi`       — advertises no `mode` option at all.
 * Policing the value on those three would 409 an ordinary permission change,
 * which is a legitimate user action and no privilege change at all. The value
 * ALONE cannot be classified — `plan` is BOTH an OpenCode agent and a Claude
 * permission mode — so the decision is made from `runtime_harness`, which the
 * session fixed at create and a caller cannot influence.
 *
 * A session with NO committed native agent is not policed either: its Kortix
 * agent is not an OpenCode agent (verified live: `metadata.native_agent` is null
 * exactly when the compiled plan has `nativeAgent: null`), so the only reachable
 * modes are OpenCode's own built-ins, which carry no grant. That is also the only
 * shape a legitimate `build` ⇄ `plan` switch can have. The product's own clients
 * send `mode` ONLY as the committed native agent (packages/sdk
 * core/acp/session-controller.ts, projects/session-lifecycle/headless-acp.ts,
 * kortix-sandbox-agent-server main.ts), so nothing the product does is refused.
 */

export type AcpAgentModeBinding = {
  /** `metadata.runtime_harness` — fixed at session create. */
  runtimeHarness: 'claude' | 'codex' | 'opencode' | 'pi';
  /** `metadata.native_agent` — the harness-native agent the session committed to
   *  at create, and the identity its `agent_grant` was minted from. */
  nativeAgent: string | null;
};

export type ForeignAgentModeSwitch = {
  expectedAgent: string;
  requestedAgent: string;
};

/** True when the envelope is a `mode` config change (of any value). Cheap
 *  pre-filter so the edges only pay for a session lookup on a real mode change. */
export function isAcpModeConfigChange(envelope: Record<string, unknown>): boolean {
  if (envelope.method !== 'session/set_config_option') return false;
  const params =
    envelope.params && typeof envelope.params === 'object' && !Array.isArray(envelope.params)
      ? (envelope.params as Record<string, unknown>)
      : {};
  return params.configId === 'mode';
}

/** The requested `mode` value when this envelope changes the mode, else null. */
function requestedModeValue(envelope: Record<string, unknown>): unknown {
  const params = envelope.params as Record<string, unknown>;
  return params.value;
}

/**
 * Non-null when this envelope would run an agent other than the one the session
 * committed to. See the module doc for the per-harness rule.
 */
export function foreignAgentModeSwitch(
  binding: AcpAgentModeBinding,
  envelope: Record<string, unknown>,
): ForeignAgentModeSwitch | null {
  if (binding.runtimeHarness !== 'opencode') return null;
  const committed = binding.nativeAgent?.trim();
  if (!committed) return null;
  if (!isAcpModeConfigChange(envelope)) return null;
  const value = requestedModeValue(envelope);
  const requested = typeof value === 'string' ? value.trim() : '';
  if (requested === committed) return null;
  // A non-string value cannot PROVE it names the committed agent. Refuse rather
  // than forward it and hope the harness rejects it.
  return { expectedAgent: committed, requestedAgent: requested || String(value) };
}
