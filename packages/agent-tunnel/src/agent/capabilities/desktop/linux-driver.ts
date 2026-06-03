import { spawn } from 'child_process';
import { readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { execAtspiHelper } from './atspi-helper';
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

function tmpPath(): string {
  return join(tmpdir(), `tunnel-ss-${randomBytes(6).toString('hex')}.png`);
}

function exec(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(`${cmd} failed (${code}): ${stderr}`));
      else resolve(stdout);
    });
    proc.on('error', () => {
      reject(new Error(`${cmd} not found. Install it: sudo apt install ${cmd}`));
    });
  });
}

function parsePngDimensions(buf: Buffer): { width: number; height: number } {
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50) {
    return {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
    };
  }
  return { width: 0, height: 0 };
}

const BUTTON_MAP: Record<string, string> = {
  left: '1',
  middle: '2',
  right: '3',
};

const SCROLL_MAP: Record<string, string> = {
  up: '4',
  down: '5',
  left: '6',
  right: '7',
};

export class LinuxDriver implements DesktopDriver {
  async screenshot(options: ScreenshotOptions): Promise<ScreenshotResult> {
    const path = tmpPath();

    if (options.region) {
      const { x, y, width, height } = options.region;
      await exec('scrot', ['-a', `${x},${y},${width},${height}`, path]);
    } else if (options.windowId) {
      await exec('scrot', ['-u', '-w', path]);
    } else {
      await exec('scrot', [path]);
    }

    const buf = await readFile(path);
    await unlink(path).catch(() => {});
    const { width, height } = parsePngDimensions(buf);

    return {
      image: buf.toString('base64'),
      width,
      height,
      format: 'png',
    };
  }

  async mouseClick(options: MouseClickOptions): Promise<void> {
    const button = BUTTON_MAP[options.button || 'left'] || '1';
    const clicks = options.clicks || 1;

    await exec('xdotool', ['mousemove', '--sync', String(options.x), String(options.y)]);

    const clickArgs = ['click', '--repeat', String(clicks), button];
    await exec('xdotool', clickArgs);
  }

  async mouseMove(options: MouseMoveOptions): Promise<void> {
    await exec('xdotool', ['mousemove', '--sync', String(options.x), String(options.y)]);
  }

  async mouseDrag(options: MouseDragOptions): Promise<void> {
    const button = BUTTON_MAP[options.button || 'left'] || '1';

    await exec('xdotool', ['mousemove', '--sync', String(options.fromX), String(options.fromY)]);
    await exec('xdotool', ['mousedown', button]);
    await exec('xdotool', ['mousemove', '--sync', String(options.toX), String(options.toY)]);
    await exec('xdotool', ['mouseup', button]);
  }

  async mouseScroll(options: MouseScrollOptions): Promise<void> {
    await exec('xdotool', ['mousemove', '--sync', String(options.x), String(options.y)]);

    const dy = options.deltaY || 0;
    const dx = options.deltaX || 0;

    if (dy !== 0) {
      const btn = dy > 0 ? SCROLL_MAP.down : SCROLL_MAP.up;
      const count = Math.abs(dy);
      for (let i = 0; i < count; i++) {
        await exec('xdotool', ['click', btn]);
      }
    }

    if (dx !== 0) {
      const btn = dx > 0 ? SCROLL_MAP.right : SCROLL_MAP.left;
      const count = Math.abs(dx);
      for (let i = 0; i < count; i++) {
        await exec('xdotool', ['click', btn]);
      }
    }
  }

  async mousePosition(): Promise<MousePosition> {
    const out = await exec('xdotool', ['getmouselocation']);
    const match = out.match(/x:(\d+)\s+y:(\d+)/);
    if (!match) throw new Error(`Failed to parse mouse location: ${out}`);
    return { x: parseInt(match[1]), y: parseInt(match[2]) };
  }

  async keyboardType(options: KeyboardTypeOptions): Promise<void> {
    const args = ['type'];
    if (options.delay) {
      args.push('--delay', String(options.delay));
    }
    args.push('--', options.text);
    await exec('xdotool', args);
  }

  async keyboardKey(options: KeyboardKeyOptions): Promise<void> {
    const combo = options.keys.map(k => {
      const map: Record<string, string> = {
        cmd: 'super', command: 'super',
        ctrl: 'ctrl', control: 'ctrl',
        alt: 'alt', option: 'alt',
        shift: 'shift',
        enter: 'Return', return: 'Return',
        tab: 'Tab', space: 'space',
        escape: 'Escape', esc: 'Escape',
        delete: 'BackSpace', backspace: 'BackSpace',
        up: 'Up', down: 'Down', left: 'Left', right: 'Right',
        home: 'Home', end: 'End',
        pageup: 'Prior', pagedown: 'Next',
      };
      return map[k.toLowerCase()] || k;
    }).join('+');

    await exec('xdotool', ['key', combo]);
  }

  async windowList(): Promise<WindowInfo[]> {
    const out = await exec('wmctrl', ['-l', '-G', '-p']);
    const lines = out.trim().split('\n').filter(Boolean);

    return lines.map(line => {
      const parts = line.split(/\s+/);
      const id = parseInt(parts[0], 16);
      const x = parseInt(parts[3]);
      const y = parseInt(parts[4]);
      const width = parseInt(parts[5]);
      const height = parseInt(parts[6]);
      const title = parts.slice(8).join(' ');

      return {
        id,
        app: parts[7] || '',
        title,
        bounds: { x, y, width, height },
        minimized: false,
      };
    });
  }

  async windowFocus(windowId: number): Promise<void> {
    await exec('wmctrl', ['-i', '-a', `0x${windowId.toString(16)}`]);
  }

  async windowResize(windowId: number, bounds: Partial<WindowBounds>): Promise<void> {
    const windows = await this.windowList();
    const win = windows.find(w => w.id === windowId);
    if (!win) throw new Error(`Window ${windowId} not found`);

    const x = bounds.x ?? win.bounds.x;
    const y = bounds.y ?? win.bounds.y;
    const w = bounds.width ?? win.bounds.width;
    const h = bounds.height ?? win.bounds.height;

    await exec('wmctrl', ['-i', '-r', `0x${windowId.toString(16)}`, '-e', `0,${x},${y},${w},${h}`]);
  }

  async windowClose(windowId: number): Promise<void> {
    await exec('wmctrl', ['-i', '-c', `0x${windowId.toString(16)}`]);
  }

  async windowMinimize(windowId: number): Promise<void> {
    await exec('xdotool', ['windowminimize', String(windowId)]);
  }

  async appLaunch(name: string): Promise<void> {
    const proc = spawn('xdg-open', [name], {
      stdio: 'ignore',
      detached: true,
    });
    proc.unref();
    await new Promise(r => setTimeout(r, 500));
  }

  async appQuit(name: string): Promise<void> {
    const target = name.trim();
    if (!target || target.length > 128) throw new Error('Invalid app name');
    const apps = await this.appList();
    const pids = [...new Set(apps
      .filter(app => app.name === target || app.bundleId === target)
      .map(app => String(app.pid)))];

    for (const pid of pids) {
      await exec('kill', [pid]).catch(() => {});
    }
  }

  async appList(): Promise<AppInfo[]> {
    const out = await exec('wmctrl', ['-l', '-p']);
    const lines = out.trim().split('\n').filter(Boolean);

    const seen = new Set<number>();
    const apps: AppInfo[] = [];

    for (const line of lines) {
      const parts = line.split(/\s+/);
      const pid = parseInt(parts[2]);
      if (pid && !seen.has(pid)) {
        seen.add(pid);
        let name = parts.slice(4).join(' ');
        try {
          const cmdline = await exec('cat', [`/proc/${pid}/comm`]);
          name = cmdline.trim() || name;
        } catch {}
        apps.push({ name, pid });
      }
    }

    return apps;
  }

  async clipboardRead(): Promise<string> {
    return exec('xclip', ['-selection', 'clipboard', '-o']);
  }

  async clipboardWrite(text: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('xclip', ['-selection', 'clipboard'], {
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      proc.on('close', (code) => {
        if (code !== 0) reject(new Error(`xclip failed (${code})`));
        else resolve();
      });
      proc.on('error', () => reject(new Error('xclip not found. Install: sudo apt install xclip')));
      proc.stdin.write(text);
      proc.stdin.end();
    });
  }

  async screenInfo(): Promise<ScreenInfo> {
    const out = await exec('xrandr', ['--current']);
    const match = out.match(/(\d+)x(\d+)\+/);
    if (!match) throw new Error('Failed to parse xrandr output');

    return {
      width: parseInt(match[1]),
      height: parseInt(match[2]),
      scaleFactor: 1,
    };
  }

  async cursorImage(radius: number = 50): Promise<ScreenshotResult> {
    const pos = await this.mousePosition();
    const x = Math.max(0, pos.x - radius);
    const y = Math.max(0, pos.y - radius);
    const size = radius * 2;

    return this.screenshot({ region: { x, y, width: size, height: size } });
  }

  async axTree(options: AXTreeOptions): Promise<AXTreeResult> {
    const res = await execAtspiHelper({
      action: 'ax_tree',
      pid: options.pid,
      maxDepth: options.maxDepth ?? 8,
      roles: options.roles,
    });
    return {
      root: res.root,
      elementCount: res.elementCount!,
    };
  }

  async axAction(options: AXActionOptions): Promise<AXActionResult> {
    const res = await execAtspiHelper({
      action: 'ax_action',
      elementId: options.elementId,
      action_name: options.action,
      pid: options.pid,
    });
    return res as unknown as AXActionResult;
  }

  async axSetValue(options: AXSetValueOptions): Promise<AXSetValueResult> {
    const res = await execAtspiHelper({
      action: 'ax_set_value',
      elementId: options.elementId,
      value: options.value,
      pid: options.pid,
    });
    return res as unknown as AXSetValueResult;
  }

  async axFocus(options: AXFocusOptions): Promise<AXFocusResult> {
    const res = await execAtspiHelper({
      action: 'ax_focus',
      elementId: options.elementId,
      pid: options.pid,
    });
    return res as unknown as AXFocusResult;
  }

  async axSearch(options: AXSearchOptions): Promise<AXSearchResult> {
    const res = await execAtspiHelper({
      action: 'ax_search',
      query: options.query,
      role: options.role,
      pid: options.pid,
      maxResults: options.maxResults ?? 20,
    });
    return { elements: res.elements || [] };
  }
}
