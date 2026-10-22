// Writes the input schemas of the pinned cua-driver's tools that the `computer`
// connector exposes, so agents see the driver's real arguments (pid,
// window_id, element_token, …), never a hand-copied guess.
//
//   node apps/desktop-electron/scripts/dump-cua-tools.js
//
// Run it after every VERSION bump in fetch-cua-driver.js. The API unit test
// `unit-computer-catalog.test.ts` fails while the snapshot names another version.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { fetchCuaDriver, VERSION } = require('./fetch-cua-driver');

/** The tools with their own connector action; `desktop.cua.call` reaches the rest. */
const TOOLS = [
  'health_report',
  'get_screen_size',
  'list_apps',
  'list_windows',
  'get_accessibility_tree',
  'get_window_state',
  'get_desktop_state',
  'launch_app',
  'click',
  'double_click',
  'right_click',
  'type_text',
  'press_key',
  'hotkey',
  'scroll',
  'drag',
  'set_value',
];

const OUT = path.join(__dirname, '..', '..', 'api', 'src', 'connectors', 'cua-driver-tools.generated.json');

async function main() {
  const binary = await fetchCuaDriver();
  if (!binary) throw new Error('dump-cua-tools needs macOS (the pinned driver is a macOS binary)');
  const tools = {};
  for (const tool of TOOLS) {
    const text = execFileSync(binary, ['describe', tool], { encoding: 'utf8', env: { ...process.env, CUA_DRIVER_RS_TELEMETRY_ENABLED: '0' } });
    const description = text.split('description:')[1].split('input_schema:')[0].trim().split('\n\n')[0];
    const schema = JSON.parse(text.slice(text.indexOf('{', text.indexOf('input_schema:'))));
    // The connector's caller is one agent session; the driver's own session label adds nothing.
    delete schema.properties?.session;
    tools[tool] = { description, input_schema: schema };
  }
  fs.writeFileSync(OUT, `${JSON.stringify({ driver_version: VERSION, tools }, null, 2)}\n`);
  console.log(`[kortix] ${TOOLS.length} cua-driver ${VERSION} tool schemas → ${path.relative(process.cwd(), OUT)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
