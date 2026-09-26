/**
 * Honest, actionable copy for EVERY non-success outcome of starting a session
 * from a chat channel — surfaced in the conversation instead of a generic "try
 * again", so a real blocker tells the user exactly what to do. Every error
 * shape the create path (createProjectSession + the session lifecycle) can
 * return is mapped here: most-specific by `code`, then by HTTP status, then a
 * safe generic fallback.
 *
 * Shared by Slack and Teams. The classification is identical on both — only the
 * command a user is pointed at differs, so each platform passes its own
 * `StartErrorCommands`. Before this was shared, Teams had a four-branch copy of
 * its own (402 / 429 / 404 / generic): every code case and 400, 403, 409 and
 * 5xx collapsed to "give it a moment and send your message again", which is
 * actively wrong advice for a dead sandbox template or a missing account link —
 * retrying hits the same wall forever.
 *
 * The AGENT_NOT_DECLARED case is handled by its own inline-picker branch at the
 * call sites — it needs an interactive card, not a text line — so it never
 * reaches here.
 *
 * Pure + dependency-free (mirrors slack/errors.ts) so it's unit-tested in
 * isolation, with no config/DB import to boot. Keep it exhaustive: an unmapped
 * status must still read sensibly and always leave the user a next step.
 */

/** The platform's own vocabulary: what it calls the place the turn happened,
 *  and the commands that fix each blocker, already formatted for its markup. */
export interface StartErrorCommands {
  /** What the user calls this place — Slack says "channel", Teams "conversation". */
  surface: string;
  /** Opens this conversation's Kortix settings. */
  settings: string;
  /** Re-points this conversation at a project. */
  switchProject: string;
  /** Links the user's Kortix account. */
  login: string;
}

export const SLACK_START_ERROR_COMMANDS: StartErrorCommands = {
  surface: 'channel',
  settings: '`/kortix`',
  switchProject: '`/kortix switch`',
  login: '`/kortix login`',
};

export const TEAMS_START_ERROR_COMMANDS: StartErrorCommands = {
  surface: 'conversation',
  settings: '`/status`',
  switchProject: '`/projects`',
  login: '`/login`',
};

export function startErrorMessage(
  status: number | undefined,
  body: unknown,
  commands: StartErrorCommands,
): string {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const code = typeof b.code === 'string' ? b.code : undefined;
  const detail = typeof b.error === 'string' ? b.error.trim() : '';
  // A short, human 400 detail is worth surfacing verbatim; a long internal one
  // (stack-ish message, SQL error) is noise — drop it and keep the copy clean.
  const shortDetail = detail && detail.length <= 160 ? detail : '';

  // Most specific: known error CODES from the create path.
  switch (code) {
    case 'UNKNOWN_SANDBOX_TEMPLATE':
      return "I couldn't start a session — the sandbox template configured for this project no longer exists. Update it in the project's Kortix settings, then send your message again.";
    case 'KORTIX_URL_UNREACHABLE':
      return "I couldn't start a session — Kortix couldn't reach the sandbox runtime just now. This is usually a brief infrastructure hiccup; give it a moment and send your message again.";
    case 'WORKSPACE_MODE_UNAVAILABLE':
      return "I couldn't start a session because the agent uses the `read` workspace mode. Restricted workspace artifacts are not enabled yet. Set the agent's workspace to `runtime` or `branch`, then send your message again.";
    case 'session_already_exists':
      return "I couldn't start a session — one with this id already exists. Start a new one and send your message again.";
  }

  // Then HTTP status.
  switch (status) {
    case 400:
      return `I couldn't start a session — the request was rejected${shortDetail ? ` (${shortDetail})` : ''}. Check this ${commands.surface}'s Kortix settings with ${commands.settings}, then send your message again.`;
    case 402:
      return "This workspace is out of credits, so I can't start a session. Top up in the Kortix dashboard and send your message again.";
    case 403:
      return "I couldn't start a session — this workspace doesn't have permission to run one here. Ask a Kortix workspace admin to grant access, then send your message again.";
    case 404:
      return `I couldn't find this project to start a session — it may have been moved or deleted. Reconnect Kortix to this ${commands.surface} with ${commands.switchProject}, then try again.`;
    case 409:
      return `I couldn't find a Kortix account to run this session as. Connect your account with ${commands.login}, then send your message again.`;
    case 429:
      return 'This workspace is at its concurrent-session limit right now. Close or finish a running session, then send your message again.';
    case 500:
    case 502:
    case 503:
    case 504:
      return "I couldn't start a session — Kortix hit a temporary error. Give it a moment and send your message again — I'll reply right here.";
  }

  // Unknown status/code — never leave the user without a next step.
  return `I couldn't start a session just now${shortDetail ? ` (${shortDetail})` : ''}. Give it a moment and send your message again — I'll reply right here.`;
}
