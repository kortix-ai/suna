import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAuthorizeUrl, parseToken, SetupTokenError, startSetupToken } from './setup-token';

const URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=test-client&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&state=abc';
const TOKEN = 'sk-ant-oat01-SyntheticTestTokenValue_0123456789-abcdefghijklmnop';

// A stand-in for `claude setup-token`: the same output shape the real binary
// prints under a pseudo-terminal (OSC-8 link, paste prompt, token), and it
// reads the pasted code from the terminal. It records the browser it was given.
function fakeClaude(dir: string): string {
  const path = join(dir, 'claude');
  writeFileSync(path, `#!/bin/bash
[ "$1" = "setup-token" ] || exit 2
printf 'Welcome to Claude Code\\r\\n'
printf 'Browser didn'"'"'t open? Use the url below to sign in\\r\\n'
printf '\\033]8;id=1;%s\\007%s\\033]8;;\\007\\r\\n' '${URL}' '${URL.slice(0, 60)}'
printf 'HOME=%s CFG=%s\\r\\n' "$HOME" "$CLAUDE_CONFIG_DIR" > "${dir}/env.txt"
printf 'OPENER=%s\\n' "$(command -v xdg-open)" >> "${dir}/env.txt"
printf 'Paste code here if prompted > '
read -r code
code="\${code%$'\\r'}"
if [ "$code" = "good-code" ]; then
  printf '\\r\\n\\033[32m✓ Long-lived authentication token created successfully!\\033[0m\\r\\n'
  printf ' Your OAuth token (valid for 1 year):\\r\\n %s\\r\\n' '${TOKEN}'
  printf 'Store this token securely.\\r\\n'
  exit 0
fi
printf '\\r\\nOAuth error: Invalid code\\r\\n'
exit 1
`);
  chmodSync(path, 0o755);
  return path;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('claude setup-token run', () => {
  test('captures the authorize URL, takes the pasted code and returns the token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
    dirs.push(dir);
    const run = await startSetupToken({ claudePath: fakeClaude(dir), startTimeoutMs: 10_000 });
    expect(run.authorizeUrl).toBe(URL);
    expect(await run.submit('good-code', 10_000)).toBe(TOKEN);
    const env = await Bun.file(join(dir, 'env.txt')).text();
    // The run had its own HOME and config dir, and `xdg-open` reached the no-op shim.
    expect(env).toContain('kortix-claude-login-');
    expect(env).toContain('/.claude');
    const home = env.match(/HOME=(\S+)/)![1]!;
    expect(env).toContain(`OPENER=${home}/bin/xdg-open`);
    run.stop();
    expect(existsSync(home)).toBe(false);
  });

  test('a rejected code fails with invalid_code', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
    dirs.push(dir);
    const run = await startSetupToken({ claudePath: fakeClaude(dir), startTimeoutMs: 10_000 });
    const failure = await run.submit('bad-code', 10_000).catch((error) => error);
    expect(failure).toBeInstanceOf(SetupTokenError);
    expect((failure as SetupTokenError).code).toBe('invalid_code');
    run.stop();
  });

  test('a missing binary fails with claude_unavailable', async () => {
    const failure = await startSetupToken({ claudePath: '/nonexistent/claude-binary-for-test' }).catch((error) => error);
    expect((failure as SetupTokenError).code).toBe('claude_unavailable');
  });
});

describe('output parsing', () => {
  test('a token that wraps across lines is joined', () => {
    const raw = `created successfully!\r\n Your OAuth token (valid for 1 year):\r\n ${TOKEN.slice(0, 30)}\r\n ${TOKEN.slice(30)}\r\nStore this token securely.`;
    expect(parseToken(raw)).toBe(TOKEN);
  });

  test('the visible URL is read when the output carries no hyperlink', () => {
    expect(parseAuthorizeUrl(`Use the url below to sign in\n${URL}\nPaste code`)).toBe(URL);
  });

  test('no token in the output reads as null', () => {
    expect(parseToken('Paste code here if prompted >')).toBeNull();
  });
});
