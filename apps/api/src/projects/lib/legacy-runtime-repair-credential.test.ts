import { describe, expect, test } from 'bun:test';

import {
  bootstrapLegacyRuntime,
  renderLegacyBootstrapScript,
  type LegacyBootstrapDeps,
} from './legacy-runtime-bootstrap';

/**
 * A repair may never depend on the credential of the box it is repairing.
 *
 * Measured on dev 2026-09-27: `legacy-runtime-sweep.ts --session <id> --force`
 * answered `failed (script failed at manifest)` / `manifest fetch from
 * <api> failed`, because the script authenticates its manifest fetch with the
 * box's own `KORTIX_SANDBOX_TOKEN`/`KORTIX_TOKEN` — and a session credential is
 * refused whenever its sandbox row is not `provisioning`/`active`
 * (repositories/account-tokens.ts). The same URL answered 200 from a laptop
 * with a PAT, and the identical `--force` run converged in 51 s once the row
 * had been flipped to `active` by hand.
 *
 * A repair path that only works when the box is already healthy is useless
 * exactly when it is needed.
 */
const LEGACY_HEALTH = { daemon: 'ok', status: 'ok', opencode: 'ok', runtimeReady: true };
const CURRENT_HEALTH = {
  daemon: 'ok',
  opencode: 'ok',
  runtime: { build: 1, components: { agent: 'current', opencode: 'current' } },
};

const REPAIR_SECRET = 'kortix_pat_repair_synthetic';

interface Calls {
  execs: string[][];
  released: number;
}

function deps(over: Partial<LegacyBootstrapDeps>, calls: Calls): LegacyBootstrapDeps {
  const healths = [LEGACY_HEALTH, CURRENT_HEALTH];
  let i = 0;
  return {
    now: () => 1_000_000,
    sleep: async () => {},
    manifestBuild: async () => 1,
    fetchHealth: async () => healths[Math.min(i++, healths.length - 1)],
    fetchOpencodeStatus: async () => ({}),
    mintRepairToken: async () => ({
      secret: REPAIR_SECRET,
      release: async () => {
        calls.released += 1;
      },
    }),
    exec: async (cmd) => {
      calls.execs.push(cmd);
      return {
        exitCode: 0,
        stdout: '{"ok":true,"stage":"relaunched","agent_sha256":"a","entrypoint_sha256":"e"}\n',
        stderr: '',
      };
    },
    patchMetadata: async () => {},
    audit: async () => {},
    log: () => {},
    ...over,
  };
}

const input = () => ({
  sandboxId: 'sb1',
  externalId: 'sbx_1',
  provider: 'platinum',
  metadata: null,
  reason: 'sweep',
});

function decodeScript(command: string[]): string {
  const b64 = /'([A-Za-z0-9+/=]+)'/.exec(command[2])?.[1] ?? '';
  return Buffer.from(b64, 'base64').toString('utf8');
}

describe('the repair credential', () => {
  test('the script fetches the manifest with the repair token, not the box token', () => {
    const script = renderLegacyBootstrapScript({ relaunch: 'pt-app', repairToken: REPAIR_SECRET });
    expect(script).toContain(`REPAIR_TOKEN='${REPAIR_SECRET}'`);
    // The manifest fetch and every asset download authenticate with the
    // control-plane credential when one was issued.
    expect(script).toContain('Authorization: Bearer $FETCH_TOKEN');
    expect(script).not.toContain('Authorization: Bearer $TOKEN"');
    // The box's own token is still read — it is what the daemon boots with —
    // but it is no longer what the repair depends on.
    expect(script).toContain('readenv KORTIX_SANDBOX_TOKEN');
  });

  test('a box with no usable token of its own can still be repaired', () => {
    // The preflight used to refuse the whole run with "no sandbox token on
    // this box". With a control-plane credential in hand, that is no longer a
    // reason to stop.
    const script = renderLegacyBootstrapScript({ relaunch: 'pt-app', repairToken: REPAIR_SECRET });
    expect(script).not.toContain('fail preflight "no sandbox token on this box"');
    expect(script).toContain('no credential for the manifest fetch');
  });

  test('without a repair token the script still falls back to the box credential', () => {
    const script = renderLegacyBootstrapScript({ relaunch: 'pt-app' });
    expect(script).toContain("REPAIR_TOKEN=''");
    expect(script).toContain('FETCH_TOKEN="$REPAIR_TOKEN"');
  });

  test('the bootstrap mints one, ships it, and releases it afterwards', async () => {
    const calls: Calls = { execs: [], released: 0 };
    const result = await bootstrapLegacyRuntime(input(), deps({}, calls));
    expect(result.outcome).toBe('converged');
    expect(decodeScript(calls.execs[0])).toContain(`REPAIR_TOKEN='${REPAIR_SECRET}'`);
    // A repair credential outliving the repair is a credential nobody revokes.
    expect(calls.released).toBe(1);
  });

  test('the credential is released even when the exec throws', async () => {
    const calls: Calls = { execs: [], released: 0 };
    const result = await bootstrapLegacyRuntime(
      input(),
      deps(
        {
          exec: async () => {
            throw new Error('provider exec refused');
          },
        },
        calls,
      ),
    );
    expect(result.outcome).toBe('failed');
    expect(calls.released).toBe(1);
  });

  test('a mint failure never blocks the repair: it runs on the box credential', async () => {
    const calls: Calls = { execs: [], released: 0 };
    const result = await bootstrapLegacyRuntime(
      input(),
      deps(
        {
          mintRepairToken: async () => {
            throw new Error('token store down');
          },
        },
        calls,
      ),
    );
    expect(result.outcome).toBe('converged');
    expect(decodeScript(calls.execs[0])).toContain("REPAIR_TOKEN=''");
  });
});
