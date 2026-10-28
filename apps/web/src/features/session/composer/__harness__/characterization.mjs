import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
assert.ok(
  process.env.COMPOSER_BROWSER_CONFIG,
  'Set COMPOSER_BROWSER_CONFIG to a local-browser config',
);
assert.ok(
  process.env.COMPOSER_HARNESS_ORIGIN,
  'Serve the documented composer harness and set COMPOSER_HARNESS_ORIGIN',
);
const ab = (...args) =>
  execFileSync(
    'agent-browser',
    ['--config', process.env.COMPOSER_BROWSER_CONFIG, '--session', 'k3431-local', ...args],
    { encoding: 'utf8' },
  );
for (const bottom of [0, 1]) {
  test(`composer bottom=${bottom}: selection, state logging and rerender`, () => {
    ab('open', `${process.env.COMPOSER_HARNESS_ORIGIN}/?state=1&bottom=${bottom}`);
    ab('fill', '[contenteditable=true]', '/deploy');
    assert.match(ab('snapshot', '-i'), /option "deploy"/);
    ab('eval', 'window.__rerender()');
    assert.match(ab('snapshot', '-i'), /option "deploy"/);
    ab('press', 'Enter');
    const log = ab('eval', 'JSON.stringify(window.__log)');
    assert.match(log, /command:deploy/);
    assert.match(log, /menu:true/);
    assert.match(log, /menu:false/);
    assert.match(ab('eval', 'String(window.__handle() !== null)'), /true/);
    if (!bottom) assert.match(ab('get', 'text', '#harness-log'), /command:deploy/);
  });
}
