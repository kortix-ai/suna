/**
 * Computer connectors (the Agent Computer Tunnel as a first-class Connector
 * connector).
 *   • catalog — the tunnel RPC method set normalizes to `tunnel` bindings, with
 *     no machine selector because each connector is bound to one tunnel.
 *   • parse   — `provider="computer"` cannot be declared in kortix.yaml (it is
 *     synth-only; connecting a machine materializes it).
 *   • gateway — a computer call routes through executeComputerCall (NOT an HTTP
 *     call); the connector's bound tunnel id is used; a permission_required
 *     outcome becomes pending_approval; missing-machine / relay errors become errors.
 */
import { describe, expect, test } from 'bun:test';
import { computerCatalog, computerLabel } from '../connectors/computers';
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

  test('does not expose account-wide machine discovery', () => {
    expect(byPath.has('list_computers')).toBe(false);
  });

  test('fs.read → tunnel fs.read, read, path required, no machine selector', () => {
    const a = byPath.get('fs.read')!;
    expect(a.binding).toEqual({ kind: 'tunnel', method: 'fs.read' });
    expect(a.risk).toBe('read');
    const props = Object.keys((a.inputSchema as any).properties);
    expect(props).not.toContain('computer');
    expect(props).toContain('path');
    expect((a.inputSchema as any).required).toEqual(['path']); // selector NOT required
  });

  test('fs.delete is destructive; shell.exec is write', () => {
    expect(byPath.get('fs.delete')!.risk).toBe('destructive');
    expect(byPath.get('shell.exec')!.risk).toBe('write');
  });

  test('desktop.cua.call is the generic passthrough (tool + args)', () => {
    const a = byPath.get('desktop.cua.call')!;
    expect(a.binding).toEqual({ kind: 'tunnel', method: 'desktop.cua.call' });
    const props = Object.keys((a.inputSchema as any).properties);
    expect(props).toContain('tool');
    expect(props).not.toContain('computer');
  });

  test('label', () => {
    expect(computerLabel()).toBe('Computer');
  });
});

/* ─── parse ───────────────────────────────────────────────────────────────── */

function parse(body: string) {
  const src = [`kortix_version: ${KNOWN_SCHEMA_VERSION}`, 'project:\n  name: t', body].join('\n');
  return extractConnectors(parseManifestString(src, 'yaml', 'kortix.yaml'));
}

describe('connectors: provider="computer"', () => {
  test('cannot be declared in kortix.yaml (synth-only)', () => {
    const { specs, errors } = parse(`
connectors:
  - slug: computer
    provider: computer
`);
    expect(specs).toEqual([]);
    expect(errors[0]!.error).toMatch(/managed automatically|cannot be declared/);
  });
});

/* ─── gateway execution ───────────────────────────────────────────────────── */

const COMPUTER: GatewayConnector = {
  connectorId: 'conn-computer',
  slug: 'computer-11111111-1111-4111-8111-111111111111',
  provider: 'computer',
  tunnelId: '11111111-1111-4111-8111-111111111111',
  baseUrl: null,
  auth: { type: 'none', in: 'header', name: null, prefix: null },
  hasAuth: false, // no credential — the relay is the credential
  credentialMode: 'shared',
  enabled: true,
};

const FS_READ: GatewayAction = {
  path: 'computer-11111111-1111-4111-8111-111111111111.fs.read',
  relPath: 'fs.read',
  inputSchema: { type: 'object', properties: { path: {} }, required: ['path'] },
  risk: 'read',
  binding: { kind: 'tunnel', method: 'fs.read' },
};

function makeDeps(outcome: ComputerCallOutcome, action: GatewayAction = FS_READ) {
  const calls: Array<Parameters<NonNullable<GatewayDeps['executeComputerCall']>>[0]> = [];
  const deps: GatewayDeps = {
    loadConnectorBySlug: async () => COMPUTER,
    loadAction: async () => action,
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

function input(args: Record<string, unknown>, actionPath = 'fs.read'): CallInput {
  return {
    projectId: 'proj-1',
    accountId: 'acct-1',
    subject: { userId: 'u1', groupIds: [] },
    sessionId: 'sess-1',
    connectorSlug: COMPUTER.slug,
    actionPath,
    args,
  };
}

describe('handleCall — computer (tunnel)', () => {
  test('relays through the connector-bound tunnel without a selector argument', async () => {
    const { deps, calls } = makeDeps({ ok: true, data: { content: 'hello' } });
    const res = await handleCall(deps, input({ path: '/tmp/x' }));
    expect(res.status).toBe('ok');
    if (res.status === 'ok') expect(res.data).toEqual({ content: 'hello' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      accountId: 'acct-1',
      actorUserId: 'u1',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      tunnelId: '11111111-1111-4111-8111-111111111111',
      method: 'fs.read',
      args: { path: '/tmp/x' },
    });
  });

  test('permission_required → pending_approval, requestId surfaced', async () => {
    const { deps } = makeDeps({
      ok: false,
      kind: 'permission_required',
      requestId: 'req-9',
      message: 'no grant',
    });
    const res = await handleCall(deps, input({ path: '/etc/hosts' }));
    expect(res.status).toBe('pending_approval');
    if (res.status === 'pending_approval') expect(res.reason).toMatch(/req-9/);
  });

  test('no_machine → error', async () => {
    const { deps } = makeDeps({
      ok: false,
      kind: 'no_machine',
      message: 'No machine is online',
    });
    const res = await handleCall(deps, input({ path: '/x' }));
    expect(res.status).toBe('error');
    if (res.status === 'error') expect(res.reason).toMatch(/online/);
  });

  test('a connector without a bound tunnel fails closed', async () => {
    const { deps } = makeDeps({ ok: true, data: {} });
    deps.loadConnectorBySlug = async () => ({ ...COMPUTER, tunnelId: null });
    const res = await handleCall(deps, input({ path: '/tmp/x' }));
    expect(res).toEqual({
      status: 'error',
      reason: 'computer connector has no bound machine',
    });
  });
});
