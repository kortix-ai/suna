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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { capabilityForMethod, normalizeDesktopCall } from 'agent-tunnel';
import cuaDriverTools from '../connectors/cua-driver-tools.generated.json';
import { validateScopeForOperation } from '../tunnel/core/permission-checker';
import { computerCatalog, uniqueComputerLabel, withComputerCatalog } from '../connectors/computers';
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

  test('desktop schemas are the pinned driver\'s own: targeting fields present, scroll takes a direction', () => {
    const pin = /const VERSION = '([^']+)'/.exec(
      readFileSync(join(import.meta.dir, '../../../desktop-electron/scripts/fetch-cua-driver.js'), 'utf8'),
    )?.[1];
    // A driver bump must regenerate the snapshot: node apps/desktop-electron/scripts/dump-cua-tools.js
    expect(cuaDriverTools.driver_version).toBe(pin!);
    const schema = (path: string) => byPath.get(path)!.inputSchema as any;
    for (const tool of ['click', 'type_text', 'press_key', 'hotkey', 'scroll']) {
      expect(Object.keys(schema(`desktop.cua.${tool}`).properties)).toEqual(
        expect.arrayContaining(['pid', 'window_id', 'element_token']),
      );
    }
    expect(schema('desktop.cua.scroll').required).toEqual(['direction']);
    expect(schema('desktop.cua.get_window_state').required).toEqual(['pid', 'window_id']);
    expect(byPath.get('desktop.cua.health_report')!.binding).toEqual({ kind: 'tunnel', method: 'desktop.cua.health_report' });
    for (const action of actions.filter((a) => a.path.startsWith('desktop.cua.'))) {
      expect(JSON.stringify(action.inputSchema ?? {})).not.toContain('"session"');
    }
  });
});

describe('desktop authorization', () => {
  test('a legacy feature-scoped desktop grant allows every driver tool, listed or not', () => {
    for (const tool of ['health_report', 'click', 'browser_navigate']) {
      expect(validateScopeForOperation('desktop', { features: ['screenshot'] } as any, 'cua.call', { tool }).allowed).toBe(true);
    }
  });

  test('desktop.cua.<tool> relays as desktop.cua.call, which every installed agent serves', () => {
    expect(capabilityForMethod('desktop.cua.health_report')).toBe('desktop');
    expect(capabilityForMethod('desktop.cua.')).toBeNull();
    expect(normalizeDesktopCall('desktop.cua.hotkey', { keys: ['cmd', 'c'], pid: 7, permissionId: 'p' })).toEqual({
      method: 'desktop.cua.call',
      params: { tool: 'hotkey', args: { keys: ['cmd', 'c'], pid: 7 }, permissionId: 'p' },
    });
    for (const method of ['desktop.cua.call', 'desktop.cua.describe', 'fs.read']) {
      expect(normalizeDesktopCall(method, { a: 1 })).toEqual({ method, params: { a: 1 } });
    }
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
  for (const discovery of [
    { path: 'desktop.cua.list_tools', args: {}, data: { tools: 'double_click' }, schema: null },
    {
      path: 'desktop.cua.describe', args: { tool: 'double_click' },
      data: { description: 'Double click coordinates' },
      schema: { type: 'object', properties: { tool: { type: 'string', description: 'Computer-use tool name to describe.' } }, required: ['tool'] },
    },
  ]) {
    test(`${discovery.path} uses its discovery RPC, not generic call`, async () => {
      const action = computerCatalog().find((candidate) => candidate.path === discovery.path);
      expect(action).toBeDefined();
      if (!action) throw new Error(`Missing discovery action: ${discovery.path}`);
      expect(action.risk).toBe('read');
      expect(action.inputSchema).toEqual(discovery.schema);
      expect(action.binding).toEqual({ kind: 'tunnel', method: discovery.path });
      const { deps, calls } = makeDeps({ ok: true, data: discovery.data });
      deps.loadAction = async () => ({ ...action, path: `computer.${action.path}`, relPath: action.path });
      const result = await handleCall(deps, { ...input(discovery.args), actionPath: discovery.path });
      expect(result).toEqual({
        status: 'ok', data: discovery.data, risk: 'read',
        account: { connection_id: 'conn-account-1', label: 'Studio Mac', owner_type: 'member' },
        binding: 'tunnel', output: discovery.data, upstreamStatus: null,
      });
      expect(calls).toEqual([{
        tunnelId: TUNNEL, accountId: 'acct-1', actorUserId: 'u1', projectId: 'proj-1',
        sessionId: 'sess-1', method: discovery.path, args: discovery.args,
      }]);
    });
  }

  test("relays to the resolved account's machine and echoes the account", async () => {
    const { deps, calls } = makeDeps({ ok: true, data: { content: 'hello' } });
    const res = await handleCall(deps, input({ path: '/tmp/x' }));
    expect(res).toEqual({
      status: 'ok',
      data: { content: 'hello' },
      risk: 'read',
      account: { connection_id: 'conn-account-1', label: 'Studio Mac', owner_type: 'member' },
      binding: 'tunnel',
      output: { content: 'hello' },
      upstreamStatus: null,
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

  for (const kind of ['computer_offline', 'computer_capability_not_approved', 'computer_desktop_permission_missing'] as const) {
    test(`${kind} → error reason starts with the code`, async () => {
      const { deps } = makeDeps({ ok: false, kind, message: 'detail' });
      const res = await handleCall(deps, input({ path: '/x' }));
      expect(res).toEqual({ status: 'error', reason: `${kind}: detail`, binding: 'tunnel' });
    });
  }

  test('a relay failure → error with the machine message', async () => {
    const { deps } = makeDeps({ ok: false, kind: 'error', message: 'ENOENT' });
    const res = await handleCall(deps, input({ path: '/x' }));
    expect(res).toEqual({ status: 'error', reason: 'ENOENT', binding: 'tunnel' });
  });
});

/* ─── stored catalog never wins ───────────────────────────────────────────── */

describe('withComputerCatalog()', () => {
  // An older API (mid-rollout replica, or an old stack on a shared database)
  // writes its own catalog to connector_actions. Agents must still see this one.
  const stale = [
    {
      actionId: '00000000-0000-4000-8000-000000000001',
      connectorId: 'c1',
      path: 'list_computers',
      name: 'List computers',
      description: null,
      inputSchema: null,
      outputSchema: null,
      risk: 'read' as const,
      binding: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  test('replaces a stale stored catalog for computer connectors', () => {
    const paths = withComputerCatalog('c1', 'computer', stale).map((row) => row.path);
    expect(paths).not.toContain('list_computers');
    expect(paths).toContain('status');
    expect(paths).toEqual(computerCatalog().map((action) => action.path));
  });

  test('leaves every other provider untouched', () => {
    expect(withComputerCatalog('c1', 'composio', stale)).toBe(stale);
  });
});
