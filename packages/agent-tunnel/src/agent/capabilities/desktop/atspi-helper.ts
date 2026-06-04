import { spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const HELPER_VERSION = 'v1';
const BIN_DIR = join(homedir(), '.agent-tunnel', 'bin');
const HELPER_PATH = join(BIN_DIR, `atspi-helper-${HELPER_VERSION}.py`);

const PYTHON_SOURCE = `#!/usr/bin/env python3
"""AT-SPI2 accessibility helper for Linux."""
import json
import sys

try:
    import gi
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi
except ImportError:
    print(json.dumps({"ok": False, "error": "python3-gi and gir1.2-atspi-2.0 required. Install: sudo apt install python3-gi gir1.2-atspi-2.0"}))
    sys.exit(0)

element_count = 0

def get_role_name(accessible):
    try:
        return Atspi.Accessible.get_role_name(accessible)
    except:
        return ""

def get_name(accessible):
    try:
        return Atspi.Accessible.get_name(accessible) or ""
    except:
        return ""

def get_description(accessible):
    try:
        return Atspi.Accessible.get_description(accessible) or ""
    except:
        return ""

def get_bounds(accessible):
    try:
        comp = accessible.get_component_iface()
        if comp:
            rect = comp.get_extents(Atspi.CoordType.SCREEN)
            return {"x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height}
    except:
        pass
    return {"x": 0, "y": 0, "width": 0, "height": 0}

def get_value(accessible):
    try:
        val = accessible.get_value_iface()
        if val:
            return str(val.get_current_value())
    except:
        pass
    return ""

def get_actions(accessible):
    actions = []
    try:
        action_iface = accessible.get_action_iface()
        if action_iface:
            for i in range(action_iface.get_n_actions()):
                name = action_iface.get_action_name(i)
                if name:
                    actions.append(name)
    except:
        pass
    return actions

def get_states(accessible):
    enabled = True
    focused = False
    try:
        state_set = accessible.get_state_set()
        enabled = state_set.contains(Atspi.StateType.ENABLED) or state_set.contains(Atspi.StateType.SENSITIVE)
        focused = state_set.contains(Atspi.StateType.FOCUSED)
    except:
        pass
    return enabled, focused

def walk_tree(accessible, depth, max_depth, roles, path_prefix):
    global element_count
    if accessible is None or depth > max_depth:
        return None
    element_count += 1

    role = get_role_name(accessible)
    name = get_name(accessible)
    value = get_value(accessible)
    desc = get_description(accessible)
    bounds = get_bounds(accessible)
    actions = get_actions(accessible)
    enabled, focused = get_states(accessible)

    children = []
    if depth < max_depth:
        try:
            count = accessible.get_child_count()
            for i in range(count):
                child = accessible.get_child_at_index(i)
                if child:
                    child_path = f"{path_prefix}.{i}" if path_prefix else str(i)
                    child_node = walk_tree(child, depth + 1, max_depth, roles, child_path)
                    if child_node is not None:
                        if isinstance(child_node, list):
                            children.extend(child_node)
                        else:
                            children.append(child_node)
        except:
            pass

    if roles and role.lower() not in [r.lower() for r in roles]:
        return children if children else None

    return {
        "id": path_prefix,
        "role": role,
        "title": name,
        "value": value,
        "description": desc,
        "bounds": bounds,
        "children": children,
        "actions": actions,
        "enabled": enabled,
        "focused": focused,
    }

def find_app_by_pid(pid):
    desktop = Atspi.get_desktop(0)
    count = desktop.get_child_count()
    for i in range(count):
        app = desktop.get_child_at_index(i)
        if app:
            try:
                if app.get_process_id() == pid:
                    return app
            except:
                pass
    raise Exception(f"No AT-SPI application found for PID {pid}")

def navigate_to_element(root, element_id):
    parts = element_id.split(".")
    current = root
    for part in parts:
        idx = int(part)
        child = current.get_child_at_index(idx)
        if child is None:
            raise Exception(f"Element not found at path: {element_id}")
        current = child
    return current

def search_tree(accessible, query, role_filter, max_results, results, path_prefix, depth, max_depth):
    if accessible is None or len(results) >= max_results or depth > max_depth:
        return

    role = get_role_name(accessible)
    name = get_name(accessible)
    value = get_value(accessible)
    desc = get_description(accessible)

    query_lower = query.lower()
    match = (query_lower in name.lower() or query_lower in value.lower() or query_lower in desc.lower())

    if role_filter and role.lower() != role_filter.lower():
        match = False

    if match:
        bounds = get_bounds(accessible)
        actions = get_actions(accessible)
        enabled, focused = get_states(accessible)
        results.append({
            "id": path_prefix,
            "role": role,
            "title": name,
            "value": value,
            "description": desc,
            "bounds": bounds,
            "children": [],
            "actions": actions,
            "enabled": enabled,
            "focused": focused,
        })

    try:
        count = accessible.get_child_count()
        for i in range(count):
            if len(results) >= max_results:
                break
            child = accessible.get_child_at_index(i)
            if child:
                child_path = f"{path_prefix}.{i}" if path_prefix else str(i)
                search_tree(child, query, role_filter, max_results, results, child_path, depth + 1, max_depth)
    except:
        pass

def main():
    raw = sys.stdin.read().strip()
    try:
        req = json.loads(raw)
    except:
        print(json.dumps({"ok": False, "error": "Invalid JSON input"}))
        return

    action = req.get("action", "")

    try:
        if action == "ax_tree":
            pid = req.get("pid", 0)
            max_depth = req.get("maxDepth", 8)
            roles = req.get("roles", [])

            root = find_app_by_pid(pid) if pid > 0 else Atspi.get_desktop(0)

            global element_count
            element_count = 0
            tree = walk_tree(root, 0, max_depth, roles, "0")
            print(json.dumps({"ok": True, "root": tree, "elementCount": element_count}))

        elif action == "ax_action":
            element_id = req.get("elementId", "")
            action_name = req.get("action_name", "")
            pid = req.get("pid", 0)

            root = find_app_by_pid(pid) if pid > 0 else Atspi.get_desktop(0)
            el = navigate_to_element(root, element_id)

            action_iface = el.get_action_iface()
            if not action_iface:
                raise Exception("Element does not support actions")

            performed = False
            for i in range(action_iface.get_n_actions()):
                if action_iface.get_action_name(i).lower() == action_name.lower():
                    action_iface.do_action(i)
                    performed = True
                    break

            if not performed:
                raise Exception(f"Action '{action_name}' not found on element")

            print(json.dumps({"ok": True}))

        elif action == "ax_search":
            query = req.get("query", "")
            role_filter = req.get("role", None)
            pid = req.get("pid", 0)
            max_results = req.get("maxResults", 20)

            root = find_app_by_pid(pid) if pid > 0 else Atspi.get_desktop(0)
            results = []
            search_tree(root, query, role_filter, max_results, results, "0", 0, 20)
            print(json.dumps({"ok": True, "elements": results}))

        else:
            print(json.dumps({"ok": False, "error": f"Unknown action: {action}"}))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))

if __name__ == "__main__":
    main()
`;

let written = false;

export async function ensureHelper(): Promise<string> {
  if (written && existsSync(HELPER_PATH)) return HELPER_PATH;

  if (existsSync(HELPER_PATH)) {
    written = true;
    return HELPER_PATH;
  }

  mkdirSync(BIN_DIR, { recursive: true });
  writeFileSync(HELPER_PATH, PYTHON_SOURCE, { mode: 0o755 });
  written = true;

  return HELPER_PATH;
}

export interface AtspiHelperRequest {
  action: string;
  pid?: number;
  maxDepth?: number;
  roles?: string[];
  elementId?: string;
  action_name?: string;
  query?: string;
  role?: string;
  maxResults?: number;
  value?: string;
}

export interface AtspiHelperResponse {
  ok: boolean;
  error?: string;
  root?: any;
  elementCount?: number;
  elements?: any[];
}

export async function execAtspiHelper(request: AtspiHelperRequest): Promise<AtspiHelperResponse> {
  const helperPath = await ensureHelper();

  return new Promise((resolve, reject) => {
    const proc = spawn('python3', [helperPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`AT-SPI helper failed (exit ${code}): ${stderr}`));
        return;
      }

      try {
        const response = JSON.parse(stdout.trim()) as AtspiHelperResponse;
        if (!response.ok && response.error) {
          reject(new Error(response.error));
          return;
        }
        resolve(response);
      } catch {
        reject(new Error(`Invalid helper output: ${stdout}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`python3 not found: ${err.message}. Install: sudo apt install python3`));
    });

    proc.stdin.write(JSON.stringify(request));
    proc.stdin.end();
  });
}
