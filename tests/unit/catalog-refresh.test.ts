import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

for (const existing of [false, true]) {
  test(`catalog refresh leaves ${existing ? 'an existing' : 'a new'} PR open for review`, () => {
    const workflow = readFileSync(resolve(import.meta.dirname, '../../.github/workflows/catalog-refresh.yml'), 'utf8');
    // Execute the publication step, not a duplicate of its implementation.
    const script = workflow.slice(workflow.lastIndexOf('        run: |\n') + '        run: |\n'.length)
      .split('\n').map((line) => line.replace(/^          /, '')).join('\n')
      .replaceAll('${{ steps.diff.outputs.files }}', 'seed.json');
    const dir = mkdtempSync(resolve(tmpdir(), 'catalog-refresh-'));
    dirs.push(dir);
    writeFileSync(resolve(dir, 'catalog-summary.txt'), 'Synthetic seed summary');
    writeFileSync(resolve(dir, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(resolve(dir, 'gh'), `#!/bin/sh
printf '%s %s\\n' "$1" "$2" >> "$CALLS"
case "$1 $2" in
  'pr list') [ "$EXISTING" = true ] && echo 42; exit 0 ;;
  'pr create'|'pr edit') exit 0 ;;
  *) echo 'Unexpected GitHub mutation' >&2; exit 1 ;;
esac
`, { mode: 0o755 });
    const result = spawnSync('bash', ['-euc', script], {
      cwd: dir, encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: resolve(dir, 'calls'), EXISTING: String(existing) },
    });
    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(resolve(dir, 'calls'), 'utf8').trim().split('\n');
    expect(calls.some((call) => call.startsWith(existing ? 'pr edit' : 'pr create'))).toBe(true);
    expect(calls.every((call) => /^pr (list|create|edit)$/.test(call))).toBe(true);
  });
}
