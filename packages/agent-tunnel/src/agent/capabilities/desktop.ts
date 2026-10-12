import type { Capability, RpcHandler } from './index';
import { CuaDriver } from './desktop/cua-driver';
import type { LocalPermission } from '../security/permission-guard';
import { TunnelErrorCode } from '../../shared/types';

const LOCAL_ONLY_CUA_TOOLS = new Set(['check_for_update', 'install_ffmpeg']);

function assertRemotelyCallableTool(tool: unknown): asserts tool is string {
  if (typeof tool !== 'string' || tool.length === 0) {
    throw new Error('CUA tool name is required');
  }
  if (LOCAL_ONLY_CUA_TOOLS.has(tool)) {
    throw new Error(`CUA tool "${tool}" is local-only and cannot run through Agent Tunnel`);
  }
}

/** An RPC error with a binding code (the API maps it to a refusal kind). */
export class DesktopPermissionMissingError extends Error {
  readonly code = TunnelErrorCode.DESKTOP_PERMISSION_MISSING;
}

/**
 * A failed call is first asked "does macOS let this process see and drive the
 * screen?". Without Accessibility or Screen Recording every tool fails with a
 * driver-specific message; this turns all of them into one actionable error.
 */
async function explainFailure(cua: CuaDriver, err: unknown, onMissing: () => void): Promise<never> {
  const missing = await cua.missingPermissions().catch(() => []);
  if (missing.length > 0) {
    onMissing();
    throw new DesktopPermissionMissingError(
      `computer_desktop_permission_missing: macOS has not given ${await cua.permissionOwner()} ${missing.join(' and ')} on this computer.`,
    );
  }
  throw err;
}

/**
 * Desktop is one grant ("Screen & keyboard"): an approved desktop permission
 * allows every driver tool. The tool list belongs to the installed driver.
 */
export function createDesktopCapability(options: { onPermissionMissing?: () => void } = {}): Capability {
  const cua = new CuaDriver();
  const methods = new Map<string, RpcHandler>();
  const onMissing = options.onPermissionMissing ?? (() => {});

  const assertDesktopPermission = (params: Record<string, unknown>): void => {
    const permission = params.__permission as LocalPermission | undefined;
    if (permission?.capability !== 'desktop') {
      throw new Error('Permission denied: desktop permission required');
    }
  };

  methods.set('desktop.cua.ensure', async (params) => {
    assertDesktopPermission(params);
    const binary = await cua.ensureInstalled();
    const version = await cua.version().catch(() => undefined);
    return { ok: true, binary, version };
  });

  methods.set('desktop.cua.start_daemon', async (params) => {
    assertDesktopPermission(params);
    return cua.startDaemon();
  });

  methods.set('desktop.cua.status', async (params) => {
    assertDesktopPermission(params);
    return { status: await cua.status() };
  });

  methods.set('desktop.cua.version', async (params) => {
    assertDesktopPermission(params);
    return { version: await cua.version() };
  });

  methods.set('desktop.cua.list_tools', async (params) => {
    assertDesktopPermission(params);
    return { tools: await cua.listTools() };
  });

  methods.set('desktop.cua.describe', async (params) => {
    assertDesktopPermission(params);
    return { description: await cua.describe(params.tool as string) };
  });

  methods.set('desktop.cua.call', async (params) => {
    assertDesktopPermission(params);
    const tool = params.tool;
    assertRemotelyCallableTool(tool);
    const args = (params.args || {}) as Record<string, unknown>;
    try {
      return await cua.call(tool, args);
    } catch (err) {
      return explainFailure(cua, err, onMissing);
    }
  });

  return {
    name: 'desktop',
    methods,
  };
}
