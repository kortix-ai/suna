import type { ConvergeOutcome, SessionConfigRelease } from './session-config-release';

/**
 * What happened to the agent `.md` files opencode actually reads.
 *
 * Six outcomes and not a boolean, because three of them are successes, one is a
 * deliberate refusal, and two are "we did not find out" for different reasons.
 * Collapsing any of those together is how a reload ends up warning about a
 * success — or, worse, calling a no-op a success.
 */
export type ReloadAgentFiles =
  /** Brought forward from base. The agent WILL behave differently. */
  | 'updated'
  /** Nothing to do — they already matched base. */
  | 'already-current'
  /** Refused: this session has its own edits or commits there. Kept. */
  | 'kept-yours'
  /** The project keeps no agent files in the repo. */
  | 'not-applicable'
  /** `refresh_repo: false` — never attempted. */
  | 'not-requested'
  /** A daemon built before the sync shipped could not say. */
  | 'unknown';

/** Map the daemon's raw answer onto the outcome the surfaces branch on. */
export function classifyAgentFiles(input: {
  requested: boolean;
  synced: boolean | null;
  reason?: string;
}): ReloadAgentFiles {
  if (!input.requested) return 'not-requested';
  if (input.synced === true) return 'updated';
  if (input.synced === null) return 'unknown';
  switch (input.reason) {
    case 'already matches base':
      return 'already-current';
    case 'local changes':
    case 'local commits':
      return 'kept-yours';
    case 'no tracked config dir':
    case 'not in base':
      return 'not-applicable';
    default:
      // fetch failed / checkout failed / anything new: we cannot claim the agent
      // changed, and we must not claim the user's version was deliberately kept.
      return 'unknown';
  }
}

/**
 * Does the box need the push — and the opencode restart that comes with it?
 *
 * Two independent reasons, because the config has two homes. Files that were
 * just brought forward are read only at opencode's spawn, so they need the
 * restart even when the compiled etag did not move (a skill body is not part of
 * it). And a moved etag needs the push even when the files were kept: governance
 * — connectors, secrets, scope — lives in the compiled config alone.
 *
 * An unknown etag on either side is NOT a reason. "Could not tell" is not
 * permission to restart a runtime nobody asked to restart.
 */
export function configNeedsPush(input: {
  agentFiles: ReloadAgentFiles;
  runningEtag: string | null;
  latestEtag: string | null;
}): boolean {
  if (input.agentFiles === 'updated') return true;
  return (
    input.runningEtag !== null &&
    input.latestEtag !== null &&
    input.runningEtag !== input.latestEtag
  );
}

/**
 * The session's own `/workspace` checkout, after a reload.
 *
 *  • `updated`         — fast-forwarded to a new commit.
 *  • `already-current` — nothing to pull.
 *  • `not-requested`   — the caller passed `refresh_repo: false`.
 *  • `refused`         — the box declined the pull (local changes, no remote).
 */
export type WorkspaceCheckout = 'updated' | 'already-current' | 'not-requested' | 'refused';

/** Classify the checkout half of a reload from the commits before and after. */
export function classifyWorkspaceCheckout(input: {
  requested: boolean;
  ok: boolean;
  before: string | null;
  after: string | null;
}): WorkspaceCheckout {
  if (!input.requested) return 'not-requested';
  if (!input.ok) return 'refused';
  if (input.before && input.after && input.before !== input.after) return 'updated';
  return 'already-current';
}

export interface SessionReloadResult {
  /** True when the agent config the box runs was actually replaced. */
  applied: boolean;
  /** What the box was running before, as reported by the box itself. */
  previous_etag: string | null;
  /** What it runs now (or would run — see `applied`). */
  etag: string | null;
  /** Whether the workspace was pulled, and to what. */
  repo_refreshed: boolean;
  commit_sha: string | null;
  /**
   * What happened to the agent files opencode ACTUALLY reads.
   *
   * This, not `applied`, decides whether the agent behaves differently: opencode
   * is spawned with `OPENCODE_CONFIG_DIR` pointing into the working tree, and
   * the `.md` files there beat the compiled config this pushes as JSON. So
   * `applied: true` with anything but `updated` means the etag moved and the
   * agent did not.
   *
   * A boolean was not enough. `false` conflated a deliberate refusal with two
   * outcomes that are plain successes (nothing to do, project keeps no agent
   * files), and `null` conflated "an old daemon could not say" with "we never
   * tried because refresh_repo was false" — so both the CLI and the web toast
   * classified real successes as warnings and vice versa.
   */
  agent_files: ReloadAgentFiles;
  /**
   * How the box applied the new config, when it said.
   *
   * `kept-old` is the verified swap declining: the daemon booted the new
   * opencode, it never started serving, so the previous one was left running.
   * The push landed and the config did NOT take — which is a FAILED reload with
   * a healthy session, a combination `applied` alone cannot express.
   *
   * `null` means the box did not say (a daemon older than the verified swap, or
   * no reload was needed) — never "it worked".
   */
  opencode_reload: 'disposed' | 'restarted' | 'kept-old' | null;
  /**
   * Did the reload stop a turn the user was waiting on?
   *
   * Reported by the box AFTER the fact — it is true only when the finalize
   * actually aborted an incomplete turn. A pre-flight "is a turn running?"
   * check would race the turn finishing and tell people their work was
   * interrupted when it completed normally.
   *
   * `null` = the box did not say. Never render that as "nothing was
   * interrupted"; say nothing instead.
   */
  turn_ended: boolean | null;
  /** Present when nothing was applied. */
  reason?: string;
  /**
   * The config release state after the reload (spec, "`GET /config`,
   * extended"). Present only for a daemon with `config.release.v1`. Same
   * shape as `SessionConfigRelease` in `@kortix/sdk`.
   */
  release?: SessionConfigRelease;
  /** The converge `outcome`, or null when the daemon did not answer. Present with `release`. */
  release_outcome?: ConvergeOutcome | null;
  /**
   * Which path the reload took: `release` sent `POST /kortix/config/converge`;
   * `legacy` sent only `POST /kortix/refresh?restart=0` plus the compiled
   * governance push. Absent when the box was not reached.
   */
  config_path?: 'release' | 'legacy';
  /**
   * What happened to the session's own `/workspace` checkout — the OTHER half
   * of a reload. A reload does two things and must report both: it
   * fast-forwards the checkout, and it converges the config the box runs.
   * Absent when the box was not reached at all.
   */
  workspace_checkout?: WorkspaceCheckout;
}

/** Server-observed boundaries emitted by the streamed reload route. */
export type SessionReloadPhase =
  | 'checking-session'
  | 'refreshing-workspace'
  | 'compiling-config'
  | 'applying-config'
  | 'confirming-config';

/**
 * One sentence for the reload, and the only place that decides whether we are
 * allowed to say the agent changed.
 *
 * The old copy — "Reloaded. The next prompt runs the new config." — was
 * unconditional, and measurably false whenever the agent's `.md` files were not
 * brought forward: the etag moved, opencode kept reading the working tree, and
 * the user was told the opposite.
 */
/**
 * The sentence appended when the reload STOPPED work someone was waiting on.
 *
 * The reload restarts the runtime, so the command has to report when it ends a
 * turn. Until now the turn simply ended —
 * cleanly, so nothing spun, but silently, so it looked like the agent gave up.
 *
 * Only appended on a definite `true`. `null` means the box could not tell, and
 * inventing "your turn was stopped" for a turn that finished normally is worse
 * than saying nothing.
 */
const TURN_ENDED_SENTENCE =
  'The turn that was running was stopped — send a message to continue.';

function withTurnNotice(sentence: string, result: SessionReloadResult): string {
  return result.turn_ended === true ? `${sentence} ${TURN_ENDED_SENTENCE}` : sentence;
}

/**
 * A fallback outranks every other sentence: the box runs a config other than
 * the one it was assigned, and the CLI prints only this text.
 */
function fallbackSentence(result: SessionReloadResult): string | null {
  const reason = result.release?.fallback_reason;
  if (!reason) return null;
  return `The new config failed to load: ${reason.replace(/\.$/, '')}. ${fallbackRunsSentence(result.release?.source)}`;
}

/** What serves the session after a fallback, named the way the web header names it. */
function fallbackRunsSentence(source: string | undefined): string {
  if (source === 'image-default') return 'The platform default config runs this session.';
  return 'An earlier config still runs this session.';
}

/**
 * A reload does TWO things: it fast-forwards the session's `/workspace`
 * checkout, and it converges the config the box runs. Both are reported, in
 * one sentence each, so a half-sync is never silent. Empty when the API did
 * not run the checkout half at all.
 *
 * The wording lives here, server-side, because every surface renders
 * `detail`: `kortix sessions reload`, the web's "Reload config" toast, and the
 * streamed reload. One sentence, one place.
 */
function checkoutSentence(result: SessionReloadResult): string {
  const at = result.commit_sha ? ` at ${result.commit_sha.slice(0, 12)}` : '';
  switch (result.workspace_checkout) {
    case 'updated':
      return `The /workspace checkout was updated${at}.`;
    case 'already-current':
      return `The /workspace checkout was already current${at}.`;
    case 'not-requested':
      return 'The /workspace checkout was left alone; this call did not ask for it.';
    case 'refused':
      return 'The /workspace checkout was NOT updated: the sandbox declined the pull.';
    default:
      return '';
  }
}

export function reloadDetail(result: SessionReloadResult): string {
  const checkout = checkoutSentence(result);
  const withCheckout = (text: string) => (checkout ? `${text} ${checkout}` : text);
  const fallback = fallbackSentence(result);
  if (fallback) return withCheckout(withTurnNotice(fallback, result));
  if (!result.applied) return withCheckout(`Nothing to apply: ${result.reason ?? 'unchanged'}.`);
  return withCheckout(withTurnNotice(reloadOutcomeSentence(result), result));
}

function reloadOutcomeSentence(result: SessionReloadResult): string {
  switch (result.agent_files) {
    case 'updated':
      return 'Reloaded. The next prompt runs the new config.';
    case 'already-current':
      return 'Reloaded. The agent files were already current.';
    case 'not-applicable':
      return 'Reloaded. This project keeps no agent files in the repo, so only the compiled config changed.';
    case 'kept-yours':
      return 'Config pushed, but this session has its own changes to its agent files — those were kept, so the agent still runs YOUR version.';
    case 'not-requested':
      return 'Compiled config pushed. Agent files were left alone because the repo refresh was skipped.';
    default:
      return 'Config pushed, but this sandbox could not confirm its agent files were updated — restart the session if the agent still behaves the old way.';
  }
}

/**
 * Is this an outcome the user should be nudged about?
 *
 * Only two are: their own version was kept, or we could not confirm. Everything
 * else — including the two cases where nothing needed doing — is a success, and
 * warning on those was the first thing the review caught.
 */
export function reloadNeedsAttention(result: SessionReloadResult): boolean {
  if (result.release?.fallback_reason) return true;
  if (!result.applied) return true;
  return result.agent_files === 'kept-yours' || result.agent_files === 'unknown';
}
