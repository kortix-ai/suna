/**
 * Computer connectors (the Agent Computer Tunnel as a first-class connector).
 *   • catalog — the tunnel RPC method set normalizes to `tunnel` bindings. No
 *     action takes a machine selector: the account IS the machine.
 *   • parse   — `provider="computer"` cannot be declared in kortix.yaml.
 *   • gateway — a computer call relays to the resolved account's machine
 *     (`connectionTunnelId`) through executeComputerCall (NOT an HTTP call);
 *     an unpaired account fails `computer_unpaired` without relaying; typed
 *     machine failures surface their code.
 *   • label   — duplicate machine names get a numbered label.
 */
import { describe, expect, test } from 'bun:test';
import { computerCatalog, uniqueComputerLabel } from '../connectors/computers';
import { extractConnectors } from '../projects/connectors';
import { parseManifestString, KNOWN_SCHEMA_VERSION } from '../projects/triggers';
import {
  handleCall,
  type CallInput,
  type ComputerCallOutcome,
  type GatewayConnector,
  type GatewayAction,
  type GatewayDeps,
} from '../connectors/gateway';

/* ─── catalog ─────────────────────────────────────────────────────────────── */

describe('computerCatalog()', () => {
  const actions = computerCatalog();
  const byPath = new Map(actions.map((a) => [a.path, a]));

  test('every action is a tunnel binding', () => {
    expect(actions.length).toBeGreaterThan(5);
    for (const a of actions) {
      expect(a.binding.kind).toBe('tunnel');
      if (a.binding.kind === 'tunnel') expect(typeof a.binding.method).toBe('string');
    }
  });

  test('status replaces list_computers and takes no input', () => {
    expect(byPath.get('list_computers')).toBeUndefined();
    const action = byPath.get('status');
    expect(action?.binding).toEqual({ kind: 'tunnel', method: 'status' });
    expect(action?.risk).toBe('read');
    expect(action?.inputSchema).toBeNull();
  });

  test('no action accepts a machine selector', () => {
    for (const a of actions) {
      const props = Object.keys(((a.inputSchema as any)?.properties ?? {}) as object);
      expect(props).not.toContain('computer');
    }
  });

  test('fs.read → tunnel fs.read, read, path required', () => {
    const a = byPath.get('fs.read')!;
    expect(a.binding).toEqual({ kind: 'tunnel', method: 'fs.read' });
    expect(a.risk).toBe('read');
    expect((a.inputSchema as any).required).toEqual(['path']);
  });

  test('fs.delete is destructive; shell.exec is write', () => {
    expect(byPath.get('fs.delete')!.risk).toBe('destructive');
    expect(byPath.get('shell.exec')!.risk).toBe('write');
  });

  test('desktop.cua.call is the generic passthrough (tool + args)', () => {
    const a = byPath.get('desktop.cua.call')!;
    expect(a.binding).toEqual({ kind: 'tunnel', method: 'desktop.cua.call' });
    expect(Object.keys((a.inputSchema as any).properties)).toEqual(['tool', 'args']);
  });
});

describe('uniqueComputerLabel()', () => {
  test('keeps a free name, numbers a taken one case-insensitively', () => {
    expect(uniqueComputerLabel('Studio Mac', new Set())).toBe('Studio Mac');
    expect(uniqueComputerLabel('Studio Mac', new Set(['studio mac']))).toBe('Studio Mac (2)');
    expect(uniqueComputerLabel('Studio Mac', new Set(['Studio Mac', 'Studio Mac (2)']))).toBe(
      'Studio Mac (3)',
    );
    expect(uniqueComputerLabel('   ', new Set())).toBe('Computer');
  });
});

/* ─── parse ───────────────────────────────────────────────────────────────── */

function parse(body: string) {
  const src = [`kortix_version: ${KNOWN_SCHEMA_VERSION}`, 'project:\n  name: t', body].join('\n');
  return extractConnectors(parseManifestString(src, 'yaml', 'kortix.yaml'));
}

describe('connectors: provider="computer"', () => {
  test('cannot be declared in kortix.yaml because pairing creates it', () => {
    const { specs, errors } = parse(`
connectors:
  - slug: computer
    provider: computer
`);
    expect(specs).toEqual([]);
    expect(errors[0]!.error).toMatch(/cannot be declared/);
  });
});

/* ─── gateway execution ───────────────────────────────────────────────────── */

const TUNNEL = '22222222-2222-4222-8222-222222222222';
const COMPUTER: GatewayConnector = {
  connectorId: 'conn-computer',
  connectionId: 'conn-account-1',
  connectionLabel: 'Studio Mac',
  connectionOwnerType: 'member',
  connectionTunnelId: TUNNEL,
  slug: 'computer',
  provider: 'computer',
  baseUrl: null,
  auth: { type: 'none', in: 'header', name: null, prefix: null },
  hasAuth: false, // no credential — the relay is the credential
  credentialMode: 'shared',
  enabled: true,
};

const FS_READ: GatewayAction = {
  path: 'computer.fs.read',
  relPath: 'fs.read',
  inputSchema: { type: 'object', properties: { path: {} }, required: ['path'] },
  risk: 'read',
  binding: { kind: 'tunnel', method: 'fs.read' },
};

function makeDeps(outcome: ComputerCallOutcome, connector: GatewayConnector = COMPUTER) {
  const calls: Array<Parameters<NonNullable<GatewayDeps['executeComputerCall']>>[0]> = [];
  const deps: GatewayDeps = {
    loadConnectorBySlug: async () => connector,
    loadAction: async () => FS_READ,
    resolveCredential: async () => null, // never called — hasAuth is false
    loadPolicies: async () => [],
    loadProjectPolicies: async () => [],
    loadDefaultMode: async () => 'allow_all',
    recordExecution: async () => null,
    fetchImpl: async () => {
      throw new Error('fetch must not be used for a computer call');
    },
    executeComputerCall: async (i) => {
      calls.push(i);
      return outcome;
    },
  };
  return { deps, calls };
}

function input(args: Record<string, unknown>): CallInput {
  return {
    projectId: 'proj-1',
    accountId: 'acct-1',
    subject: { userId: 'u1', groupIds: [] },
    sessionId: 'sess-1',
    connectorSlug: COMPUTER.slug,
    actionPath: 'fs.read',
    args,
  };
}

describe('handleCall — computer (tunnel)', () => {
  test("relays to the resolved account's machine and echoes the account", async () => {
    const { deps, calls } = makeDeps({ ok: true, data: { content: 'hello' } });
    const res = await handleCall(deps, input({ path: '/tmp/x' }));
    expect(res).toEqual({
      status: 'ok',
      data: { content: 'hello' },
      risk: 'read',
      account: { connection_id: 'conn-account-1', label: 'Studio Mac', owner_type: 'member' },
    });
    expect(calls).toEqual([
      {
        tunnelId: TUNNEL,
        accountId: 'acct-1',
        actorUserId: 'u1',
        projectId: 'proj-1',
        sessionId: 'sess-1',
        method: 'fs.read',
        args: { path: '/tmp/x' },
      },
    ]);
  });

  test('an account whose machine was unpaired fails computer_unpaired without relaying', async () => {
    const { deps, calls } = makeDeps({ ok: true, data: {} }, { ...COMPUTER, connectionTunnelId: null });
    const res = await handleCall(deps, input({ path: '/tmp/x' }));
    expect(res.status).toBe('error');
    if (res.status === 'error') expect(res.reason).toMatch(/^computer_unpaired: /);
    expect(calls).toHaveLength(0);
  });

  for (const kind of ['computer_offline', 'computer_capability_not_approved'] as const) {
    test(`${kind} → error reason starts with the code`, async () => {
      const { deps } = makeDeps({ ok: false, kind, message: 'detail' });
      const res = await handleCall(deps, input({ path: '/x' }));
      expect(res).toEqual({ status: 'error', reason: `${kind}: detail` });
    });
  }

  test('a relay failure → error with the machine message', async () => {
    const { deps } = makeDeps({ ok: false, kind: 'error', message: 'ENOENT' });
    const res = await handleCall(deps, input({ path: '/x' }));
    expect(res).toEqual({ status: 'error', reason: 'ENOENT' });
  });
});
