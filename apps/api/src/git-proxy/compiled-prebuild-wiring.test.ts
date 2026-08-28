import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const sessions = readFileSync(join(root, 'projects/lib/sessions.ts'), 'utf8');
const gitProxy = readFileSync(join(root, 'git-proxy/index.ts'), 'utf8');

describe('compiled boot prebuild wiring', () => {
  test('starts exact-session artifact builds before sandbox provisioning', () => {
    const prebuild = sessions.indexOf('prebuildCompiledBootArtifacts(');
    const provision = sessions.indexOf('provisionSessionSandbox(', prebuild);

    expect(prebuild).toBeGreaterThan(-1);
    expect(provision).toBeGreaterThan(prebuild);
  });

  test('prebuilds default-branch artifacts after a successful Git push', () => {
    const receivePackGate = gitProxy.indexOf("suffix === '/git-receive-pack'");
    const prebuild = gitProxy.indexOf('prebuildDefaultBranchArtifacts(');

    expect(receivePackGate).toBeGreaterThan(-1);
    expect(prebuild).toBeGreaterThan(receivePackGate);
  });
});
