/**
 * The CLI prints the cause and the fix when the API answers 409
 * `repository_disconnected` (KRTX-2955), and `kortix projects info` shows the
 * git connection state with the reconnect link.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import { ApiError } from '../api/client';
import { surfaceApiError } from '../command-helpers';
import { gitConnectionLines } from '../commands/projects';
import { stripAnsi } from '../style';

const message =
  'Kortix cannot reach acme/app: the Kortix GitHub App was uninstalled from acme. A GitHub owner of acme must reinstall it: Project settings → Git → Reconnect GitHub.';

let stderr: ReturnType<typeof spyOn> | null = null;
afterEach(() => stderr?.mockRestore());

describe('repository_disconnected in the CLI', () => {
  test('surfaceApiError prints the server sentence and where the reconnect link is', () => {
    const lines: string[] = [];
    stderr = spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    const code = surfaceApiError(
      new ApiError(409, message, { error: message, code: 'repository_disconnected', reason: 'app_uninstalled' }),
    );
    const out = stripAnsi(lines.join(''));
    expect(code).toBe(1);
    expect(out).toContain(message);
    expect(out).toContain('kortix projects info');
    expect(out).not.toContain('HTTP 409');
  });

  test('projects info shows a disconnected repository with its cause and the reconnect link', () => {
    const out = stripAnsi(
      gitConnectionLines({
        state: 'reconnect_required',
        reason: 'repository_disconnected',
        disconnected_reason: 'app_uninstalled',
        message,
        install_url: 'https://github.com/apps/kortix/installations/new?state=s',
      }),
    );
    expect(out).toContain('git        disconnected (app_uninstalled)');
    expect(out).toContain(message);
    expect(out).toContain('reconnect  https://github.com/apps/kortix/installations/new?state=s');
  });

  test('a healthy repository is one line', () => {
    expect(stripAnsi(gitConnectionLines({ state: 'connected' }))).toBe('  git        connected\n');
  });
});
