import { describe, expect, test } from 'bun:test';
import { PI_SYSTEM_PACKAGES, assertPiSystemPackage } from '../../runtime-versions';
import { PI_AGENT_DIR, kortixToolchainLayer, piSystemPackageLines } from '../dockerfile-layer';

describe('pi system packages', () => {
  test('install the way pi installs a global package: <agentDir>/npm plus settings.json', () => {
    const lines = piSystemPackageLines(['npm:pi-web-access@0.30.0', 'npm:@juicesharp/rpiv-todo@1.2.0']).join('\n');
    expect(lines).toContain(`mkdir -p ${PI_AGENT_DIR}/npm`);
    expect(lines).toContain('npm install --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund pi-web-access@0.30.0 @juicesharp/rpiv-todo@1.2.0');
    expect(lines).toContain(
      `> ${PI_AGENT_DIR}/settings.json`,
    );
    expect(lines).toContain(`'{"packages":["npm:pi-web-access@0.30.0","npm:@juicesharp/rpiv-todo@1.2.0"]}'`);
  });

  test('an empty list adds no layer', () => {
    expect(piSystemPackageLines([])).toEqual([]);
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
