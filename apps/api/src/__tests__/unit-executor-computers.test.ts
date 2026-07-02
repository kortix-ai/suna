/**
 * Computer connectors (the Agent Computer Tunnel as a first-class Executor
 * connector).
 *   • catalog — the tunnel RPC method set normalizes to `tunnel` bindings, with
 *     a `computer` machine selector on relayed actions and a meta list_computers.
 *   • parse   — `provider="computer"` cannot be declared in kortix.toml (it is
 *     synth-only; connecting a machine materializes it).
 *   • gateway — a computer call routes through executeComputerCall (NOT an HTTP
 *     call); the `computer` selector is pulled out of args; a permission_required
 *     outcome becomes pending_approval; no_machine / error become errors.
 */
import { describe, expect, test } from 'bun:test';
import { computerCatalog, computerLabel } from '../executor/computers';
import { extractConnectors } from '../projects/connectors';
import { parseManifestString, KNOWN_SCHEMA_VERSION } from '../projects/triggers';
import {
  handleCall,
  type CallInput,
  type ComputerCallOutcome,
  type GatewayConnector,
  type GatewayAction,
  type GatewayDeps,
} from '../executor/gateway';

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

  test('list_computers is a read meta action with no selector', () => {
    const a = byPath.get('list_computers')!;
    expect(a.binding).toEqual({ kind: 'tunnel', method: 'list_computers' });
    expect(a.risk).toBe('read');
    // meta action: no `computer` selector in its schema
    expect(a.inputSchema).toBeNull();
  });

  test('fs.read → tunnel fs.read, read, path required + computer selector', () => {
    const a = byPath.get('fs.read')!;
    expect(a.binding).toEqual({ kind: 'tunnel', method: 'fs.read' });
    expect(a.risk).toBe('read');
    const props = Object.keys((a.inputSchema as any).properties);
    expect(props).toContain('computer'); // machine selector merged in
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
    expect(props).toContain('computer');
  });

  test('label', () => {
    expect(computerLabel()).toBe('Computers');
  });
});

/* ─── parse ───────────────────────────────────────────────────────────────── */

function parse(body: string) {
  const src = [`kortix_version = ${KNOWN_SCHEMA_VERSION}`, '\n[project]\nname = "t"\n', body].join('\n');
  return extractConnectors(parseManifestString(src));
}

describe('[[connectors]] provider="computer"', () => {
  test('cannot be declared in kortix.toml (synth-only)', () => {
    const { specs, errors } = parse(`
[[connectors]]
slug = "computer"
provider = "computer"
`);
    expect(specs).toEqual([]);
    expect(errors[0]!.error).toMatch(/managed automatically|cannot be declared/);
  });
});

/* ─── gateway execution ───────────────────────────────────────────────────── */

const COMPUTER: GatewayConnector = {
  connectorId: 'conn-computer',
  slug: 'computer',
  provider: 'computer',
  baseUrl: null,
  auth: { type: 'none', in: 'header', name: null, prefix: null },
  hasAuth: false, // no credential — the relay is the credential
  shareScope: 'project',
  grants: [],
  credentialMode: 'shared',
  enabled: true,
};

const FS_READ: GatewayAction = {
  path: 'computer.fs.read',
  relPath: 'fs.read',
  inputSchema: { type: 'object', properties: { computer: {}, path: {} }, required: ['path'] },
  risk: 'read',
  binding: { kind: 'tunnel', method: 'fs.read' },
};

const LIST: GatewayAction = {
  path: 'computer.list_computers',
  relPath: 'list_computers',
  inputSchema: null,
  risk: 'read',
  binding: { kind: 'tunnel', method: 'list_computers' },
};

function makeDeps(outcome: ComputerCallOutcome, action: GatewayAction = FS_READ) {
  const calls: Array<{ accountId: string; selector: string | null; method: string; args: Record<string, unknown> }> = [];
  const deps: GatewayDeps = {
    loadConnectorBySlug: async () => COMPUTER,
    loadAction: async () => action,
    resolveCredential: async () => null, // never called — hasAuth is false
    loadPolicies: async () => [],
    loadProjectPolicies: async () => [],
    loadDefaultMode: async () => 'allow_all',
    recordExecution: async () => null,
    fetchImpl: async () => { throw new Error('fetch must not be used for a computer call'); },
    executeComputerCall: async (i) => { calls.push(i); return outcome; },
  };
  return { deps, calls };
}

function input(args: Record<string, unknown>, actionPath = 'fs.read'): CallInput {
  return {
    projectId: 'proj-1',
    accountId: 'acct-1',
    subject: { userId: 'u1', groupIds: [] },
    sessionId: 'sess-1',
    connectorSlug: 'computer',
    actionPath,
    args,
  };
}

describe('handleCall — computer (tunnel)', () => {
  test('relays via executeComputerCall, pulling the `computer` selector out of args', async () => {
    const { deps, calls } = makeDeps({ ok: true, data: { content: 'hello' } });
    const res = await handleCall(deps, input({ computer: 'laptop', path: '/tmp/x' }));
    expect(res.status).toBe('ok');
    if (res.status === 'ok') expect(res.data).toEqual({ content: 'hello' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ accountId: 'acct-1', selector: 'laptop', method: 'fs.read', args: { path: '/tmp/x' } });
  });

  test('no selector → selector is null (resolved server-side to the sole online machine)', async () => {
    const { deps, calls } = makeDeps({ ok: true, data: {} });
    await handleCall(deps, input({ path: '/tmp/x' }));
    expect(calls[0]!.selector).toBeNull();
  });

  test('permission_required → pending_approval, requestId surfaced', async () => {
    const { deps } = makeDeps({ ok: false, kind: 'permission_required', requestId: 'req-9', message: 'no grant' });
    const res = await handleCall(deps, input({ path: '/etc/hosts' }));
    expect(res.status).toBe('pending_approval');
    if (res.status === 'pending_approval') expect(res.reason).toMatch(/req-9/);
  });

  test('no_machine → error', async () => {
    const { deps } = makeDeps({ ok: false, kind: 'no_machine', message: 'No machine is online' });
    const res = await handleCall(deps, input({ path: '/x' }));
    expect(res.status).toBe('error');
    if (res.status === 'error') expect(res.reason).toMatch(/online/);
  });

  test('list_computers is relayed as the meta method (no selector pulled)', async () => {
    const { deps, calls } = makeDeps({ ok: true, data: { computers: [] } }, LIST);
    const res = await handleCall(deps, input({}, 'list_computers'));
    expect(res.status).toBe('ok');
    expect(calls[0]).toEqual({ accountId: 'acct-1', selector: null, method: 'list_computers', args: {} });
  });
});
