import { describe, expect, test } from 'bun:test';
import { PI_SYSTEM_PACKAGES, assertPiSystemPackage } from '../../runtime-versions';
import { PI_AGENT_DIR, kortixArtifactLayer, kortixToolchainLayer, piSystemPackageLines, piSystemPackageWarmLines } from '../dockerfile-layer';

describe('pi system packages', () => {
  test('install the way pi installs a global package: <agentDir>/npm plus settings.json', () => {
    const lines = piSystemPackageLines(['npm:pi-web-access@0.30.0', 'npm:@juicesharp/rpiv-todo@1.2.0']).join('\n');
    expect(lines).toContain(`mkdir -p ${PI_AGENT_DIR}/npm`);
    expect(lines).toContain('npm install --omit=dev --ignore-scripts --no-audit --no-fund pi-web-access@0.30.0 @juicesharp/rpiv-todo@1.2.0');
    // Required peers install; the pi-supplied ones resolve to one empty stub.
    expect(lines).toContain('"@earendil-works/pi-coding-agent":"file:./pi-supplied"');
    expect(lines).toContain(
      `> ${PI_AGENT_DIR}/settings.json`,
    );
    expect(lines).toContain(`'{"packages":["npm:pi-web-access@0.30.0","npm:@juicesharp/rpiv-todo@1.2.0"]}'`);
  });

  test('an empty list adds no layer', () => {
    expect(piSystemPackageLines([])).toEqual([]);
    expect(piSystemPackageWarmLines([])).toEqual([]);
  });

  test('the image warms their extension cache with the daemon itself, as the sandbox user', () => {
    const lines = piSystemPackageWarmLines(['npm:pi-web-access@0.30.0']);
    expect(lines.join('\n')).toContain('RUN /usr/local/bin/kortix-agent warm-pi-packages');
    const layer = kortixArtifactLayer({
      agentBinaryPath: 'a.gz', cliBinaryPath: 'c.gz', entrypointScriptPath: 'e', machineDocPath: 'm', slackCliPath: 's',
    } as never);
    const warm = piSystemPackageWarmLines(PI_SYSTEM_PACKAGES);
    for (const line of warm) expect(layer).toContain(line);
    // After the binary lands and after the switch to the sandbox user.
    if (warm.length) expect(layer.indexOf(warm[0]!)).toBeGreaterThan(layer.indexOf('USER kortix'));
  });

  test('only exact npm pins are accepted: they are inlined into a shell line', () => {
    expect(() => assertPiSystemPackage('npm:pi-web-access@0.30.0')).not.toThrow();
    expect(() => assertPiSystemPackage('npm:@scope/name@1.0.0-beta.2')).not.toThrow();
    for (const bad of ['npm:pi-web-access', 'npm:pi-web-access@^0.30.0', 'git:github.com/a/b@v1', 'npm:x@1.0.0;rm -rf /', "npm:x@1.0.0'", 'pi-web-access@0.30.0']) {
      expect(() => assertPiSystemPackage(bad)).toThrow();
    }
  });

  test('the committed list is valid and lands in the toolchain layer', () => {
    for (const source of PI_SYSTEM_PACKAGES) assertPiSystemPackage(source);
    const layer = kortixToolchainLayer({ opencodeConfigPath: 'oc.json', opencodeWarmupScriptPath: 'warm.sh', isSharedDefault: true } as never);
    for (const line of piSystemPackageLines(PI_SYSTEM_PACKAGES)) expect(layer).toContain(line);
  });
});
