import type { Capability, RpcHandler } from './index';
import { CuaDriver } from './desktop/cua-driver';

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

export function createDesktopCapability(): Capability {
  const cua = new CuaDriver();
  const methods = new Map<string, RpcHandler>();

  void (async () => {
    await cua.ensureInstalled();
    await cua.startDaemon();
  })().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[agent-tunnel] CUA driver background bootstrap skipped: ${message}`);
  });

  methods.set('desktop.cua.ensure', async () => {
    const binary = await cua.ensureInstalled();
    const version = await cua.version().catch(() => undefined);
    return { ok: true, binary, version };
  });

  methods.set('desktop.cua.start_daemon', async () => {
    return cua.startDaemon();
  });

  methods.set('desktop.cua.status', async () => {
    return { status: await cua.status() };
  });

  methods.set('desktop.cua.version', async () => {
    return { version: await cua.version() };
  });

  methods.set('desktop.cua.list_tools', async () => {
    return { tools: await cua.listTools() };
  });

  methods.set('desktop.cua.describe', async (params) => {
    return { description: await cua.describe(params.tool as string) };
  });

  methods.set('desktop.cua.call', async (params) => {
    const tool = params.tool as string;
    const args = (params.args || {}) as Record<string, unknown>;
    return cua.call(tool, args);
  });

  for (const tool of CUA_TOOLS) {
    methods.set(`desktop.cua.${tool}`, async (params) => {
      return cua.call(tool, params);
    });
  }

  return {
    name: 'desktop',
    methods,
  };
}
