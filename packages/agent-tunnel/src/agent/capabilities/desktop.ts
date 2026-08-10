import type { Capability, RpcHandler } from './index';
import { CuaDriver } from './desktop/cua-driver';
import { desktopFeatureForMethod } from '../../shared/permissions';
import type { LocalPermission } from '../security/permission-guard';

const CUA_TOOLS = [
  'bring_to_front',
  'check_for_update',
  'check_permissions',
  'click',
  'double_click',
  'drag',
  'end_session',
  'get_accessibility_tree',
  'get_agent_cursor_state',
  'get_config',
  'get_cursor_position',
  'get_recording_state',
  'get_screen_size',
  'get_window_state',
  'hotkey',
  'kill_app',
  'launch_app',
  'list_apps',
  'list_windows',
  'move_cursor',
  'page',
  'press_key',
  'replay_trajectory',
  'right_click',
  'scroll',
  'set_agent_cursor_enabled',
  'set_agent_cursor_motion',
  'set_agent_cursor_style',
  'set_config',
  'set_value',
  'start_recording',
  'install_ffmpeg',
  'start_session',
  'stop_recording',
  'type_text',
  'zoom',
];

const LOCAL_ONLY_CUA_TOOLS = new Set(['check_for_update', 'install_ffmpeg']);

function assertRemotelyCallableTool(tool: unknown): asserts tool is string {
  if (typeof tool !== 'string' || tool.length === 0) {
    throw new Error('CUA tool name is required');
  }
  if (LOCAL_ONLY_CUA_TOOLS.has(tool)) {
    throw new Error(`CUA tool "${tool}" is local-only and cannot run through Agent Tunnel`);
  }
}

export function createDesktopCapability(): Capability {
  const cua = new CuaDriver();
  const methods = new Map<string, RpcHandler>();

  const assertDesktopPermission = (params: Record<string, unknown>, method: string): void => {
    const permission = params.__permission as LocalPermission | undefined;
    if (permission?.capability !== 'desktop') {
      throw new Error('Permission denied: desktop permission required');
    }
    const features = Array.isArray(permission.scope?.features)
      ? permission.scope.features.filter((value): value is string => typeof value === 'string')
      : [];
    if (features.length === 0) return;
    const feature = desktopFeatureForMethod(method, params);
    if (!feature || !features.includes(feature)) {
      throw new Error(
        `Permission denied: desktop feature "${feature ?? 'unknown'}" is not allowed`,
      );
    }
  };

  methods.set('desktop.cua.ensure', async (params) => {
    assertDesktopPermission(params, 'desktop.cua.ensure');
    const binary = await cua.ensureInstalled();
    const version = await cua.version().catch(() => undefined);
    return { ok: true, binary, version };
  });

  methods.set('desktop.cua.start_daemon', async (params) => {
    assertDesktopPermission(params, 'desktop.cua.start_daemon');
    return cua.startDaemon();
  });

  methods.set('desktop.cua.status', async (params) => {
    assertDesktopPermission(params, 'desktop.cua.status');
    return { status: await cua.status() };
  });

  methods.set('desktop.cua.version', async (params) => {
    assertDesktopPermission(params, 'desktop.cua.version');
    return { version: await cua.version() };
  });

  methods.set('desktop.cua.list_tools', async (params) => {
    assertDesktopPermission(params, 'desktop.cua.list_tools');
    return { tools: await cua.listTools() };
  });

  methods.set('desktop.cua.describe', async (params) => {
    assertDesktopPermission(params, 'desktop.cua.describe');
    return { description: await cua.describe(params.tool as string) };
  });

  methods.set('desktop.cua.call', async (params) => {
    assertDesktopPermission(params, 'desktop.cua.call');
    const tool = params.tool;
    assertRemotelyCallableTool(tool);
    const args = (params.args || {}) as Record<string, unknown>;
    return cua.call(tool, args);
  });

  for (const tool of CUA_TOOLS) {
    if (LOCAL_ONLY_CUA_TOOLS.has(tool)) continue;
    methods.set(`desktop.cua.${tool}`, async (params) => {
      assertDesktopPermission(params, `desktop.cua.${tool}`);
      return cua.call(tool, params);
    });
  }

  return {
    name: 'desktop',
    methods,
  };
}
