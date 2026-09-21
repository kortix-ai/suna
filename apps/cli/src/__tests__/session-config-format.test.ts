import { describe, expect, test } from 'bun:test';
import type { SessionConfigRelease } from '@kortix/sdk';
import { describeConfigStatus, describeReloadOutcome } from '../commands/session-config-format';

const REF = 'abc12345';
const RUNNING = 'a'.repeat(64);
const DESIRED = 'b'.repeat(64);
const FAILED = 'c'.repeat(64);

function release(overrides: Partial<SessionConfigRelease> = {}): SessionConfigRelease {
  return {
    mode: 'follow-base',
    source: 'release',
    running_release_id: RUNNING,
    desired_release_id: RUNNING,
    proven: true,
    fallback_reason: null,
    failed_release_id: null,
    ...overrides,
  };
}

describe('describeConfigStatus — a response without `release` renders exactly as before', () => {
  test('behind', () => {
    expect(
      describeConfigStatus(
        { running_etag: 'e1', latest_etag: 'e2', stale: true, sandbox_reachable: true },
        REF,
      ),
    ).toEqual({
      tone: 'warn',
      text: 'Behind — running e1, latest is e2. Run `kortix sessions reload abc12345`.',
    });
  });

  test('up to date', () => {
    expect(
      describeConfigStatus(
        { running_etag: 'e1', latest_etag: 'e1', stale: false, sandbox_reachable: true },
        REF,
      ),
    ).toEqual({ tone: 'ok', text: 'Up to date (e1).' });
  });

  test('unknown: never claims "up to date"', () => {
    expect(
      describeConfigStatus(
        { running_etag: null, latest_etag: null, stale: null, sandbox_reachable: false },
        REF,
      ),
    ).toEqual({
      tone: 'warn',
      text: 'Sandbox unreachable — cannot tell whether this session is current.',
    });
    expect(
      describeConfigStatus(
        { running_etag: null, latest_etag: null, stale: null, sandbox_reachable: true },
        REF,
      ).text,
    ).toBe('This project has no compiled agent config to compare.');
  });
});

describe('describeConfigStatus — with a `release` block', () => {
  test('a new daemon reports null etags: release IDs replace them, never "null"', () => {
    const behind = describeConfigStatus(
      {
        running_etag: null,
        latest_etag: null,
        stale: true,
        sandbox_reachable: true,
        release: release({ desired_release_id: DESIRED }),
      },
      REF,
    );
    expect(behind).toEqual({
      tone: 'warn',
      text: `Behind — running release ${RUNNING.slice(0, 12)}, latest is ${DESIRED.slice(0, 12)}. Run \`kortix sessions reload abc12345\`.`,
    });
    expect(behind.text).not.toContain('null');

    const current = describeConfigStatus(
      { running_etag: null, latest_etag: null, stale: false, sandbox_reachable: true, release: release() },
      REF,
    );
    expect(current).toEqual({ tone: 'ok', text: `Up to date (release ${RUNNING.slice(0, 12)}).` });
  });

  test('a fallback is a warning that names the reason, what runs, and what failed', () => {
    const out = describeConfigStatus(
      {
        running_etag: null,
        latest_etag: null,
        stale: true,
        sandbox_reachable: true,
        release: release({
          desired_release_id: FAILED,
          fallback_reason: 'the replacement opencode never served',
          failed_release_id: FAILED,
        }),
      },
      REF,
    );
    expect(out.tone).toBe('warn');
    expect(out.text).toContain('the replacement opencode never served');
    expect(out.text).toContain(`release ${RUNNING.slice(0, 12)}`);
    expect(out.text).toContain(FAILED.slice(0, 12));
    // Reloading would retry the release that just failed: do not suggest it.
    expect(out.text).not.toContain('kortix sessions reload');
  });

  test('a fallback onto the workspace or the image default says so', () => {
    const workspace = describeConfigStatus(
      {
        running_etag: null,
        latest_etag: null,
        stale: true,
        sandbox_reachable: true,
        release: release({ source: 'workspace', running_release_id: null, fallback_reason: 'x' }),
      },
      REF,
    );
    expect(workspace.text).toContain('its workspace config');
    const image = describeConfigStatus(
      {
        running_etag: null,
        latest_etag: null,
        stale: true,
        sandbox_reachable: true,
        release: release({ source: 'image-default', running_release_id: null, fallback_reason: 'x' }),
      },
      REF,
    );
    expect(image.text).toContain('the image default config');
  });

  test('session-files mode is not a warning and does not suggest a reload', () => {
    const out = describeConfigStatus(
      {
        running_etag: null,
        latest_etag: null,
        stale: true,
        sandbox_reachable: true,
        release: release({ mode: 'session-files', source: 'workspace', running_release_id: null }),
      },
      REF,
    );
    expect(out.tone).toBe('ok');
    expect(out.text).toContain("this session's own config");
    expect(out.text).not.toContain('kortix sessions reload');
  });

  test('stale null with a release block still never claims "up to date"', () => {
    const out = describeConfigStatus(
      { running_etag: null, latest_etag: null, stale: null, sandbox_reachable: false, release: release() },
      REF,
    );
    expect(out).toEqual({
      tone: 'warn',
      text: 'Sandbox unreachable — cannot tell whether this session is current.',
    });
  });
});

describe('describeReloadOutcome', () => {
  const base = {
    applied: true,
    previous_etag: 'e1',
    etag: 'e2',
    repo_refreshed: false,
    agent_files: 'updated',
    detail: 'Reloaded. The next prompt runs the new config.',
  };

  test('without `release` it renders exactly as before', () => {
    expect(describeReloadOutcome(base, REF)).toEqual({
      tone: 'ok',
      text: 'Reloaded abc12345 — e1 → e2\n  Reloaded. The next prompt runs the new config.',
    });
    expect(describeReloadOutcome({ ...base, agent_files: 'kept-yours' }, REF).tone).toBe('warn');
    expect(describeReloadOutcome({ ...base, agent_files: 'unknown' }, REF).tone).toBe('warn');
    expect(describeReloadOutcome({ ...base, agent_files: 'already-current' }, REF).tone).toBe('ok');
  });

  test('a reload that ended in a fallback is a warning, not a green "Reloaded"', () => {
    const out = describeReloadOutcome(
      {
        ...base,
        detail: 'The new config failed to load: boom. An earlier config still runs this session.',
        release: release({ fallback_reason: 'boom', failed_release_id: FAILED }),
      },
      REF,
    );
    expect(out.tone).toBe('warn');
    expect(out.text).toContain('The new config failed to load: boom.');
  });

  test('null etags from a new daemon show the running release, never "null"', () => {
    const out = describeReloadOutcome(
      { ...base, previous_etag: null, etag: null, release: release() },
      REF,
    );
    expect(out.text).toBe(
      `Reloaded abc12345 — release ${RUNNING.slice(0, 12)}\n  Reloaded. The next prompt runs the new config.`,
    );
  });

  test('a reload that applied nothing is a warning carrying the server detail', () => {
    expect(describeReloadOutcome({ ...base, applied: false, detail: 'Nothing to apply: x.' }, REF)).toEqual({
      tone: 'warn',
      text: 'Nothing to apply: x.',
    });
  });

  test('a session running its own config is NOT a warning (E2E DEF-2)', () => {
    // Verification on a real box printed "!  Reloaded …" for session-files mode:
    // the tone keyed only off `agent_files === 'kept-yours'`. Running the
    // session's own edits is the intended outcome of that mode.
    const applied = describeReloadOutcome(
      { ...base, agent_files: 'kept-yours', release: release({ mode: 'session-files', source: 'workspace', running_release_id: null }) },
      REF,
    );
    expect(applied.tone).toBe('ok');
    const notApplied = describeReloadOutcome(
      {
        ...base,
        applied: false,
        agent_files: 'kept-yours',
        detail: 'Nothing to apply: this session runs its own config files.',
        release: release({ mode: 'session-files', source: 'workspace', running_release_id: null }),
      },
      REF,
    );
    expect(notApplied.tone).toBe('ok');
  });

  test('without a release block, kept-yours still warns — the old meaning is unchanged', () => {
    expect(describeReloadOutcome({ ...base, agent_files: 'kept-yours' }, REF).tone).toBe('warn');
  });

  test('a no-op reload ("already current") is not a warning (E2E DEF-2)', () => {
    expect(
      describeReloadOutcome(
        { ...base, applied: false, agent_files: 'already-current', detail: 'Nothing to apply: already current.' },
        REF,
      ),
    ).toEqual({ tone: 'ok', text: 'Nothing to apply: already current.' });
  });

  test('a refused or failed reload stays a warning', () => {
    for (const detail of ['This session is mid-turn.', 'Nothing to apply: no reachable sandbox.']) {
      expect(describeReloadOutcome({ ...base, applied: false, agent_files: 'unknown', detail }, REF).tone).toBe('warn');
    }
  });

  test('with a release block the transition shows release IDs, even when etags are set', () => {
    // Verification printed "— 37f79103ea3a16e1 → 37f79103ea3a16e1": equal etags
    // on a release that did change. The release is the identity that matters.
    const out = describeReloadOutcome(
      { ...base, previous_etag: 'e1', etag: 'e1', release: release() },
      REF,
    );
    expect(out.text.split('\n')[0]).toBe(`Reloaded abc12345 — release ${RUNNING.slice(0, 12)}`);
  });

  test('bold is applied through the injected formatter only', () => {
    const b = (s: string) => `*${s}*`;
    expect(describeReloadOutcome(base, REF, b).text).toBe(
      'Reloaded *abc12345* — e1 → e2\n  Reloaded. The next prompt runs the new config.',
    );
  });
});
