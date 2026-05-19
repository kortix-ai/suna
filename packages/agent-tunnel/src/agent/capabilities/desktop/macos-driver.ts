import { spawn } from 'child_process';
import { readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { execHelper } from './swift-helper';
import type {
  DesktopDriver,
  ScreenshotOptions,
  ScreenshotResult,
  MouseClickOptions,
  MouseMoveOptions,
  MouseDragOptions,
  MouseScrollOptions,
  MousePosition,
  KeyboardTypeOptions,
  KeyboardKeyOptions,
  WindowInfo,
  WindowBounds,
  AppInfo,
  ScreenInfo,
  AXTreeOptions,
  AXTreeResult,
  AXActionOptions,
  AXActionResult,
  AXSetValueOptions,
  AXSetValueResult,
  AXFocusOptions,
  AXFocusResult,
  AXSearchOptions,
  AXSearchResult,
} from './types';

function tmpPath(ext: string = '.png'): string {
  return join(tmpdir(), `tunnel-ss-${randomBytes(6).toString('hex')}${ext}`);
}

function exec(cmd: string, args: string[], timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (code !== 0) reject(new Error(`${cmd} failed (${code}): ${stderr}`));
      else resolve(stdout);
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      if (!killed) reject(err);
    });
  });
}

function osascript(script: string, timeoutMs = 15000, args: string[] = []): Promise<string> {
  return exec('osascript', ['-l', 'JavaScript', '-e', script, ...args], timeoutMs);
}

// ─── JXA-based Accessibility (System Events) ──────────────────────────────────
// Uses Apple's System Events bridge — no compilation, no binary caching,
// instant code updates. Every property access goes through System Events IPC.

const JXA_AX_SCRIPT = `function run(argv) {
  try {
    var p = JSON.parse(argv[0]);
    var se = Application("System Events");

    // Resolve target process: by PID or frontmost
    var proc;
    if (p.pid && p.pid > 0) {
      var m = se.processes.whose({unixId: p.pid})();
      if (!m.length) return JSON.stringify({ok:false, error:"Process with PID "+p.pid+" not found"});
      proc = m[0];
    } else {
      var m = se.processes.whose({frontmost: true})();
      if (!m.length) return JSON.stringify({ok:false, error:"No frontmost application found"});
      proc = m[0];
    }

    // Navigate to element by dot-path (e.g. "0.3.1")
    function nav(path) {
      var el = proc, parts = path.split(".");
      for (var i = 0; i < parts.length; i++) {
        try { el = el.uiElements()[parseInt(parts[i])]; }
        catch(e) { return null; }
      }
      return el;
    }

    // Read all useful properties, safely
    function props(el) {
      var r = {role:"",title:"",value:"",desc:"",pos:[0,0],sz:[0,0],en:true,foc:false,acts:[]};
      try { r.role = el.role() || ""; } catch(e) {}
      try { r.title = el.title() || ""; } catch(e) {}
      try { var v = el.value(); r.value = (v == null) ? "" : String(v); } catch(e) {}
      try { r.desc = el.description() || ""; } catch(e) {}
      try { r.pos = el.position() || [0,0]; } catch(e) {}
      try { r.sz = el.size() || [0,0]; } catch(e) {}
      try { r.en = el.enabled(); } catch(e) {}
      try { r.foc = el.focused(); } catch(e) {}
      try { r.acts = el.actions().map(function(a) { return a.name(); }); } catch(e) {}
      return r;
    }

    // Convert to output node
    function toNode(id, pr) {
      var label = pr.title || pr.value || pr.desc || "(unnamed)";
      if (label.length > 120) label = label.substring(0, 120) + "...";
      return {
        id:id, role:pr.role, title:label, value:pr.value, description:pr.desc,
        bounds:{x:pr.pos[0]||0, y:pr.pos[1]||0, width:pr.sz[0]||0, height:pr.sz[1]||0},
        enabled:pr.en, focused:pr.foc, actions:pr.acts, children:[]
      };
    }

    // ── TREE ──
    if (p.op === "tree") {
      var cnt = 0, maxD = p.maxDepth || 8;
      function walk(el, id, depth) {
        if (depth > maxD) return null;
        cnt++;
        var pr = props(el);
        var node = toNode(id, pr);
        if (depth < maxD) {
          try {
            var kids = el.uiElements();
            for (var i = 0; i < kids.length; i++) {
              var c = walk(kids[i], id + "." + i, depth + 1);
              if (c) node.children.push(c);
            }
          } catch(e) {}
        }
        return node;
      }
      var root = walk(proc, "0", 0);
      return JSON.stringify({ok:true, root:root, elementCount:cnt});
    }

    // ── ACTION (with before/after verification) ──
    if (p.op === "action") {
      var el = nav(p.elementId || "0");
      if (!el) return JSON.stringify({ok:false, error:"Element not found: " + p.elementId});
      var bPr = props(el);
      try { el.actions.byName(p.actionName).perform(); }
      catch(e) { return JSON.stringify({ok:false, error:"Action failed: " + String(e)}); }
      delay(0.05);
      var aPr = props(el);
      var changed = (bPr.foc !== aPr.foc) || (bPr.value !== aPr.value);
      return JSON.stringify({
        ok:true, action:p.actionName, elementId:p.elementId,
        before:{focused:bPr.foc, value:bPr.value},
        after:{focused:aPr.foc, value:aPr.value},
        stateChanged:changed, role:aPr.role, title:aPr.title||aPr.value||""
      });
    }

    // ── SET VALUE (direct + verify) ──
    if (p.op === "set_value") {
      var el = nav(p.elementId || "0");
      if (!el) return JSON.stringify({ok:false, error:"Element not found: " + p.elementId});
      try { el.focused = true; } catch(e) {}
      delay(0.03);
      try { el.value = p.value; }
      catch(e) {
        return JSON.stringify({ok:false, elementId:p.elementId, requestedValue:p.value,
          actualValue:"", error:"Cannot set value: " + String(e)});
      }
      delay(0.05);
      var actual = "";
      try { var v = el.value(); actual = (v == null) ? "" : String(v); } catch(e) {}
      var ok = (actual === p.value) || actual.indexOf(p.value) >= 0;
      return JSON.stringify({ok:ok, elementId:p.elementId, requestedValue:p.value,
        actualValue:actual, error:ok ? undefined : "Verification failed: value is " + JSON.stringify(actual)});
    }

    // ── FOCUS (direct + verify) ──
    if (p.op === "focus") {
      var el = nav(p.elementId || "0");
      if (!el) return JSON.stringify({ok:false, error:"Element not found: " + p.elementId});
      var bFoc = false;
      try { bFoc = el.focused(); } catch(e) {}
      try { el.focused = true; }
      catch(e) {
        return JSON.stringify({ok:false, elementId:p.elementId, role:"", title:"",
          before:{focused:bFoc}, after:{focused:false}, error:"Cannot set focus: " + String(e)});
      }
      delay(0.05);
      var pr = props(el);
      return JSON.stringify({ok:pr.foc, elementId:p.elementId, role:pr.role,
        title:pr.title||pr.value||"",
        before:{focused:bFoc}, after:{focused:pr.foc},
        error:pr.foc ? undefined : "Element does not report as focused after setting"});
    }

    // ── SEARCH ──
    if (p.op === "search") {
      var results = [], q = (p.query || "").toLowerCase(), maxR = p.maxResults || 20;
      function srch(el, id, depth) {
        if (results.length >= maxR || depth > 20) return;
        var pr = props(el);
        var txt = (pr.title + " " + pr.value + " " + pr.desc).toLowerCase();
        if (txt.indexOf(q) >= 0) {
          if (!p.role || pr.role.toLowerCase() === p.role.toLowerCase()) {
            results.push(toNode(id, pr));
          }
        }
        try {
          var kids = el.uiElements();
          for (var i = 0; i < kids.length; i++) { srch(kids[i], id+"."+i, depth+1); }
        } catch(e) {}
      }
      srch(proc, "0", 0);
      return JSON.stringify({ok:true, elements:results});
    }

    return JSON.stringify({ok:false, error:"Unknown op: " + p.op});
  } catch(e) {
    return JSON.stringify({ok:false, error:String(e)});
  }
}`;

async function runAx(params: Record<string, unknown>): Promise<any> {
  const paramsJson = JSON.stringify(params);
  const result = await exec('osascript', ['-l', 'JavaScript', '-e', JXA_AX_SCRIPT, '--', paramsJson], 30000);
  const parsed = JSON.parse(result.trim());
  if (!parsed.ok && parsed.error) throw new Error(parsed.error);
  return parsed;
}

async function captureToBase64(args: string[]): Promise<ScreenshotResult> {
  const capturePath = tmpPath('.png');
  const jpegPath = tmpPath('.jpg');
  await exec('screencapture', ['-x', '-t', 'png', ...args, capturePath]);
  await exec('sips', [
    '-s', 'format', 'jpeg',
    '-s', 'formatOptions', '60',
    '--resampleHeightWidthMax', '1920',
    capturePath,
    '--out', jpegPath,
  ]);

  let width = 0, height = 0;
  
  try {
    const info = await exec('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', jpegPath]);
    const wm = info.match(/pixelWidth:\s*(\d+)/);
    const hm = info.match(/pixelHeight:\s*(\d+)/);
    if (wm) width = parseInt(wm[1], 10);
    if (hm) height = parseInt(hm[1], 10);
  } catch {}

  const buf = await readFile(jpegPath);
  await unlink(capturePath).catch(() => {});
  await unlink(jpegPath).catch(() => {});

  return {
    image: buf.toString('base64'),
    width,
    height,
    format: 'jpeg',
  };
}

export class MacOSDriver implements DesktopDriver {
  async screenshot(options: ScreenshotOptions): Promise<ScreenshotResult> {
    const args: string[] = [];

    if (options.region) {
      const { x, y, width, height } = options.region;
      args.push('-R', `${x},${y},${width},${height}`);
    } else if (options.windowId) {
      args.push('-l', String(options.windowId));
    }

    return captureToBase64(args);
  }

  async mouseClick(options: MouseClickOptions): Promise<void> {
    await execHelper({
      action: 'click',
      x: options.x,
      y: options.y,
      button: options.button || 'left',
      clicks: options.clicks || 1,
      modifiers: options.modifiers,
    });
  }

  async mouseMove(options: MouseMoveOptions): Promise<void> {
    await execHelper({ action: 'move', x: options.x, y: options.y });
  }

  async mouseDrag(options: MouseDragOptions): Promise<void> {
    await execHelper({
      action: 'drag',
      x: options.fromX,
      y: options.fromY,
      toX: options.toX,
      toY: options.toY,
      button: options.button || 'left',
    });
  }

  async mouseScroll(options: MouseScrollOptions): Promise<void> {
    await execHelper({
      action: 'scroll',
      x: options.x,
      y: options.y,
      deltaX: options.deltaX || 0,
      deltaY: options.deltaY || 0,
    });
  }

  async mousePosition(): Promise<MousePosition> {
    const res = await execHelper({ action: 'position' });
    return { x: res.x!, y: res.y! };
  }

  async keyboardType(options: KeyboardTypeOptions): Promise<void> {
    const escaped = options.text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `
      const se = Application("System Events");
      se.keystroke("${escaped}");
    `;
    await osascript(script);

    if (options.delay) {
      await new Promise(r => setTimeout(r, options.delay));
    }
  }

  async keyboardKey(options: KeyboardKeyOptions): Promise<void> {
    await execHelper({ action: 'key', keys: options.keys });
  }

  async windowList(): Promise<WindowInfo[]> {
    const script = `
      ObjC.import("CoreGraphics");
      ObjC.import("Foundation");
      const kOnScreen = (1 << 0);
      const kExclDesk = (1 << 4);
      const raw = $.CGWindowListCopyWindowInfo(kOnScreen | kExclDesk, 0);
      const list = ObjC.unwrap(raw);
      const result = [];
      for (let i = 0; i < list.length; i++) {
        const w = list[i];
        const layer = w["kCGWindowLayer"];
        if (layer !== 0) continue;
        const owner = w["kCGWindowOwnerName"] || "";
        const name = w["kCGWindowName"];
        if (name === undefined || name === null) continue;
        const num = w["kCGWindowNumber"];
        const b = w["kCGWindowBounds"];
        result.push({
          id: num,
          app: owner,
          title: name || "",
          bounds: { x: b.X, y: b.Y, width: b.Width, height: b.Height },
          minimized: false,
        });
      }
      JSON.stringify(result);
    `;
    const out = await osascript(script);
    return JSON.parse(out.trim()) as WindowInfo[];
  }

  async windowFocus(windowId: number): Promise<void> {
    const windows = await this.windowList();
    const win = windows.find(w => w.id === windowId);
    if (!win) throw new Error(`Window ${windowId} not found`);

    const script = `
      const app = Application("${win.app}");
      app.activate();
    `;
    await osascript(script);
  }

  async windowResize(windowId: number, bounds: Partial<WindowBounds>): Promise<void> {
    const windows = await this.windowList();
    const win = windows.find(w => w.id === windowId);
    if (!win) throw new Error(`Window ${windowId} not found`);

    const parts: string[] = [];
    if (bounds.x !== undefined || bounds.y !== undefined) {
      const x = bounds.x ?? win.bounds.x;
      const y = bounds.y ?? win.bounds.y;
      parts.push(`w.position = [${x}, ${y}];`);
    }
    if (bounds.width !== undefined || bounds.height !== undefined) {
      const w = bounds.width ?? win.bounds.width;
      const h = bounds.height ?? win.bounds.height;
      parts.push(`w.size = [${w}, ${h}];`);
    }

    if (parts.length === 0) return;

    const title = win.title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `
      const se = Application("System Events");
      const proc = se.processes.byName("${win.app}");
      const wins = proc.windows();
      for (const w of wins) {
        try {
          const pos = w.position();
          if (w.title() === "${title}" && pos[0] === ${win.bounds.x} && pos[1] === ${win.bounds.y}) {
            ${parts.join('\n            ')}
            break;
          }
        } catch(e) {}
      }
    `;
    await osascript(script);
  }

  async windowClose(windowId: number): Promise<void> {
    const windows = await this.windowList();
    const win = windows.find(w => w.id === windowId);
    if (!win) throw new Error(`Window ${windowId} not found`);

    const title = win.title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `
      const se = Application("System Events");
      const proc = se.processes.byName("${win.app}");
      const wins = proc.windows();
      for (const w of wins) {
        try {
          const pos = w.position();
          if (w.title() === "${title}" && pos[0] === ${win.bounds.x} && pos[1] === ${win.bounds.y}) {
            w.buttons.whose({subrole: "AXCloseButton"})()[0].click();
            break;
          }
        } catch(e) {}
      }
    `;
    await osascript(script);
  }

  async windowMinimize(windowId: number): Promise<void> {
    const windows = await this.windowList();
    const win = windows.find(w => w.id === windowId);
    if (!win) throw new Error(`Window ${windowId} not found`);

    const title = win.title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `
      const se = Application("System Events");
      const proc = se.processes.byName("${win.app}");
      const wins = proc.windows();
      for (const w of wins) {
        try {
          const pos = w.position();
          if (w.title() === "${title}" && pos[0] === ${win.bounds.x} && pos[1] === ${win.bounds.y}) {
            w.minimized = true;
            break;
          }
        } catch(e) {}
      }
    `;
    await osascript(script);
  }

  async appLaunch(name: string): Promise<void> {
    await exec('open', ['-a', name]);
  }

  async appQuit(name: string): Promise<void> {
    const script = `function run(argv) {
      try {
        const app = Application(argv[0]);
        app.quit();
        return "ok";
      } catch(e) {
        return "error: " + e.message;
      }
    }`;
    const result = await osascript(script, 15000, [name]);
    if (result.trim().startsWith('error:')) {
      throw new Error(result.trim());
    }
  }

  async appList(): Promise<AppInfo[]> {
    const script = `
      const se = Application("System Events");
      const procs = se.processes.whose({backgroundOnly: false})();
      const result = [];
      for (const proc of procs) {
        try {
          result.push({
            name: proc.name(),
            pid: proc.unixId(),
            bundleId: proc.bundleIdentifier() || undefined,
          });
        } catch(e) {}
      }
      JSON.stringify(result);
    `;
    const out = await osascript(script);
    return JSON.parse(out.trim()) as AppInfo[];
  }

  async clipboardRead(): Promise<string> {
    return exec('pbpaste', []);
  }

  async clipboardWrite(text: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'pipe'] });
      proc.on('close', (code) => {
        if (code !== 0) reject(new Error(`pbcopy failed (${code})`));
        else resolve();
      });
      proc.on('error', reject);
      proc.stdin.write(text);
      proc.stdin.end();
    });
  }

  async screenInfo(): Promise<ScreenInfo> {
    const script = `
      ObjC.import("AppKit");
      const screen = $.NSScreen.mainScreen;
      const frame = screen.frame;
      const scale = screen.backingScaleFactor;
      JSON.stringify({
        width: frame.size.width,
        height: frame.size.height,
        scaleFactor: scale,
      });
    `;
    const out = await osascript(script);
    return JSON.parse(out.trim()) as ScreenInfo;
  }

  async cursorImage(radius: number = 50): Promise<ScreenshotResult> {
    const pos = await this.mousePosition();
    const x = Math.max(0, Math.round(pos.x - radius));
    const y = Math.max(0, Math.round(pos.y - radius));
    const size = radius * 2;

    return captureToBase64(['-R', `${x},${y},${size},${size}`]);
  }

  async axTree(options: AXTreeOptions): Promise<AXTreeResult> {
    const res = await runAx({
      op: 'tree',
      pid: options.pid || 0,
      maxDepth: options.maxDepth ?? 8,
    });
    return { root: res.root, elementCount: res.elementCount };
  }

  async axAction(options: AXActionOptions): Promise<AXActionResult> {
    return await runAx({
      op: 'action',
      elementId: options.elementId,
      actionName: options.action,
      pid: options.pid || 0,
    });
  }

  async axSetValue(options: AXSetValueOptions): Promise<AXSetValueResult> {
    return await runAx({
      op: 'set_value',
      elementId: options.elementId,
      value: options.value,
      pid: options.pid || 0,
    });
  }

  async axFocus(options: AXFocusOptions): Promise<AXFocusResult> {
    return await runAx({
      op: 'focus',
      elementId: options.elementId,
      pid: options.pid || 0,
    });
  }

  async axSearch(options: AXSearchOptions): Promise<AXSearchResult> {
    const res = await runAx({
      op: 'search',
      query: options.query,
      role: options.role,
      pid: options.pid || 0,
      maxResults: options.maxResults ?? 20,
    });
    return { elements: res.elements || [] };
  }
}
