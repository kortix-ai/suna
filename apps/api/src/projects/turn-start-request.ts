/**
 * "Does this proxied request START a turn?" — the one definition, on a LEAF.
 *
 * It lives apart from `sandbox-deadline-policy.ts` (which re-exports it, so no
 * existing import path changes) for one reason: that module imports
 * `../config`, and `sandbox-proxy/pre-prompt-env-sync.ts` must import NOTHING a
 * proxy suite replaces with `mock.module`. Bun's module registry is
 * PROCESS-wide, so a test file that pulled `config` in through this predicate
 * would cache the real module before a sibling suite could stub it — the exact
 * contamination the pre-prompt-env-sync header documents. This file imports one
 * pure port set and nothing else.
 *
 * `/command` and `/summarize` are in the set because both start a real, billable
 * turn — a classifier admitting only prompt_async/message would kill a box mid
 * command. Callers that want "a USER turn" subtract `/summarize` themselves
 * (`isTurnStartEnvSync`), because compaction carries no prompt and no agent.
 */

import { isOpencodePort } from '../shared/opencode-ports';

/** The in-box agent that reverse-proxies to opencode. */
const AGENT_PORT = 8000;

const TURN_START = /^\/session\/[^/]+\/(?:prompt_async|message|command|summarize)(?:$|[/?#])/;

/**
 * Drop the in-box dynamic-port nesting a client may address through, so one
 * path spelling reaches every predicate.
 *
 * `/p/<ext>/8000/proxy/4096/session/<id>/prompt_async` and
 * `/p/<ext>/4096/session/<id>/prompt_async` are the SAME turn. A predicate that
 * strips the prefix and one that does not disagree about that request, and two
 * turn-start preparations disagreeing inside one request is the defect this
 * module exists to make impossible.
 */
export function stripInBoxProxyPrefix(path: string): string {
  return path.replace(/^\/proxy\/\d+(?=\/)/, '');
}

/**
 * Does this proxied request START a turn? Used by the proxy to observe a run
 * beginning without trusting anything the sandbox says about itself.
 *
 * Either half of the opencode pair counts. A verified reload swaps which one is
 * live, and letting the other through here would let the box's own agent
 * traffic read as a human using a preview — extending the deadline, which is
 * exactly the self-renewal bounded lifetimes exist to prevent.
 */
export function isTurnStartRequest(port: number, method: string, path: string): boolean {
  if (method.toUpperCase() !== 'POST') return false;
  if (port !== AGENT_PORT && !isOpencodePort(port)) return false;
  return TURN_START.test(stripInBoxProxyPrefix(path));
}
