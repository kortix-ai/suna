import type { SessionConfigRelease } from '@kortix/sdk';

/**
 * What `kortix sessions reload` prints. Pure, so the wording is testable
 * without a terminal.
 *
 * A daemon that serves config releases reports `null` etags and a `release`
 * block instead. Without this module the CLI printed "running null, latest is
 * null" and "Up to date (null)", and a reload that ended in a fallback printed
 * as a green "Reloaded". A response without `release` renders exactly as it
 * did before releases existed.
 */

export type ConfigTone = 'ok' | 'warn';

export interface ConfigLine {
  tone: ConfigTone;
  text: string;
}

export interface SessionConfigStatusInput {
  running_etag: string | null;
  latest_etag: string | null;
  stale: boolean | null;
  sandbox_reachable: boolean;
  release?: SessionConfigRelease;
}

export interface SessionReloadOutcomeInput {
  applied: boolean;
  previous_etag: string | null;
  etag: string | null;
  agent_files?: string;
  detail: string;
  release?: SessionConfigRelease;
}

type Bold = (text: string) => string;
const plain: Bold = (text) => text;

/** Release IDs are 64 hex characters. Twelve identify one in a project. */
function short(id: string): string {
  return id.slice(0, 12);
}

function runningLabel(release: SessionConfigRelease, bold: Bold): string {
  if (release.source === 'workspace') return 'its workspace config';
  if (release.source === 'image-default') return 'the image default config';
  return release.running_release_id
    ? `release ${bold(short(release.running_release_id))}`
    : 'an earlier config';
}

export function describeConfigStatus(
  state: SessionConfigStatusInput,
  sessionRef: string,
  bold: Bold = plain,
): ConfigLine {
  const release = state.release;

  // A fallback is the one state that must be loud even when the box is
  // otherwise reachable: the base branch holds a config that does not start.
  // Suggesting a reload would only retry the release that just failed.
  if (release?.fallback_reason) {
    const failed = release.failed_release_id
      ? ` Failed release: ${bold(short(release.failed_release_id))}.`
      : '';
    return {
      tone: 'warn',
      text:
        `Fallback — the latest config failed to load: ${release.fallback_reason}. ` +
        `This session runs ${runningLabel(release, bold)}.${failed} ` +
        'Fix the config on the base branch; sessions pick up the fix automatically.',
    };
  }

  if (state.stale === null) {
    // Never claim "up to date" when the answer is "could not ask".
    return {
      tone: 'warn',
      text: state.sandbox_reachable
        ? 'This project has no compiled agent config to compare.'
        : 'Sandbox unreachable — cannot tell whether this session is current.',
    };
  }

  // The session edited its own config dir, so its files win until the edits
  // are merged or reverted. A reload does not change that, so do not offer one.
  if (release?.mode === 'session-files') {
    return {
      tone: 'ok',
      text: state.stale
        ? "Running this session's own config from its workspace. The base branch has newer config; it applies once this session's config edits are merged or reverted."
        : "Running this session's own config from its workspace.",
    };
  }

  const running = release?.running_release_id
    ? `release ${bold(short(release.running_release_id))}`
    : bold(String(state.running_etag));
  if (state.stale) {
    const latest = release?.desired_release_id
      ? bold(short(release.desired_release_id))
      : bold(String(state.latest_etag));
    return {
      tone: 'warn',
      text: `Behind — running ${running}, latest is ${latest}. Run \`kortix sessions reload ${sessionRef}\`.`,
    };
  }
  return {
    tone: 'ok',
    text: release?.running_release_id
      ? `Up to date (release ${short(release.running_release_id)}).`
      : `Up to date (${state.running_etag}).`,
  };
}

export function describeReloadOutcome(
  result: SessionReloadOutcomeInput,
  sessionRef: string,
  bold: Bold = plain,
  dim: Bold = plain,
): ConfigLine {
  if (!result.applied) return { tone: 'warn', text: result.detail };

  // `detail` is the server's sentence and the only thing entitled to say
  // whether the AGENT changed. Warn on the outcomes where it may not have:
  // the session's own files were kept, the box could not say, or the new
  // config did not start and an earlier one still runs.
  const needsAttention =
    result.agent_files === 'kept-yours' ||
    result.agent_files === 'unknown' ||
    Boolean(result.release?.fallback_reason);

  const transition =
    result.etag === null && result.release?.running_release_id
      ? ` — release ${short(result.release.running_release_id)}`
      : ` — ${result.previous_etag ?? 'unknown'} → ${result.etag}`;
  return {
    tone: needsAttention ? 'warn' : 'ok',
    text: `Reloaded ${bold(sessionRef)}${dim(transition)}\n  ${result.detail}`,
  };
}
