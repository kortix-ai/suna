import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';

// Execute the shipped workflow step, not a copy of its implementation.
const workflow = readFileSync(new URL('../../.github/workflows/tests.yml', import.meta.url), 'utf8');
const step = workflow.split('      - name: Install git 2.45 or later\n')[1]
  .split('      - name:')[0].split('        run: |\n')[1]
  .split('\n').filter(line => line.startsWith('          '))
  .map(line => line.slice(10)).join('\n');

for (const version of ['2.43.0', '2.47.0']) {
  test(`Git bootstrap on an Ubuntu runner with empty APT indexes and git ${version}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'git-bootstrap-'));
    try {
      const executable = (name: string, body: string) => writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
      executable('git', `if [[ -f "$STATE/upgraded" ]]; then echo 'git version 2.47.0'; else echo 'git version ${version}'; fi`);
      executable('sudo', 'exec "$@"');
      executable('apt-get', `echo "$*" >> "$STATE/calls"
if [[ "$1" == update ]]; then touch "$STATE/index"; exit 0; fi
if [[ ! -f "$STATE/index" ]]; then echo 'E: Unable to locate package software-properties-common' >&2; exit 100; fi
if [[ " $* " == *' software-properties-common '* ]]; then
  printf '#!/bin/bash\\nexit 0\\n' > "$STATE/add-apt-repository"
  chmod +x "$STATE/add-apt-repository"
else touch "$STATE/upgraded"; fi`);
      const result = spawnSync('bash', ['-e', '-c', step], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:/usr/bin:/bin`, STATE: dir } });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('git version 2.47.0');
      if (version === '2.43.0') {
        expect(readFileSync(join(dir, 'calls'), 'utf8')).toContain('install -y -qq --no-install-recommends git');
      } else {
        expect(existsSync(join(dir, 'calls'))).toBe(false);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
