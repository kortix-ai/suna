import { VOXL_RELEASE_URL, VOXL_SHA256_AMD64, VOXL_SHA256_ARM64 } from '../runtime-versions';

/**
 * The session desktop every image with an Ubuntu 24.04 base carries: Xvfb,
 * XFCE, PulseAudio and voxl (github.com/tembo/voxl, MIT), which streams the
 * display to the browser as H.264 over a WebSocket on port 6901.
 * `apps/sandbox/entrypoint.sh` starts it at boot; `kortix-desktop` (a link to
 * that script) starts, stops and reports it inside the box.
 *
 * voxl is a prebuilt binary (apps/sandbox/voxl/release.sh), so no image build
 * compiles Rust. It links Ubuntu 24.04's libx264.so.164 and libyuv. A custom
 * template on another base (Ubuntu 22.04, Debian 12) has no such packages:
 * there the step installs nothing and the box boots without a desktop, rather
 * than failing the template's whole image build. On a 24.04 base every check
 * is hard, so the platform default can never ship without one.
 *
 * Runs as root. Single line, no heredoc: E2B's Dockerfile parser cannot read
 * heredocs.
 */
export const SANDBOX_DESKTOP_PACKAGES = [
  'adwaita-icon-theme',
  'dbus-x11',
  'fonts-inter-variable',
  'greybird-gtk-theme',
  'libopus0',
  'libpulse0',
  'librsvg2-common',
  'libx264-164',
  'libyuv0',
  'pulseaudio',
  'thunar',
  'x11-xserver-utils',
  'xfce4-panel',
  'xfce4-session',
  'xfce4-settings',
  'xfce4-terminal',
  'xfdesktop4',
  'xfwm4',
  'xvfb',
];

/**
 * The path data of the brand kit's master files, as is (kortix-brand
 * `brandmark.md`: composite the file, never redraw it). `desktop.test.ts`
 * checks both against `apps/web/public/brandkit/Logo/`.
 */
export const KORTIX_LOGO_PATHS: readonly string[] = [
  'M139.522 139.53H162.84C162.84 109.932 147.046 84.0225 123.427 69.7694C147.046 55.5163 162.839 29.6068 162.839 0.00859395H139.522C139.522 28.0165 119.455 51.4472 93.0774 56.9407V0.00859395H69.7625V56.9407C43.2607 51.5428 23.3183 28.1045 23.3183 0.00859395H0.000517529C0.000517529 29.6068 15.7941 55.5163 39.4134 69.7694C15.7938 84.0225 0 109.932 0 139.53H23.3178C23.3178 111.434 43.2606 87.996 69.7625 82.5981V139.556H93.0774V82.598C119.579 87.9957 139.522 111.434 139.522 139.53Z',
  'M379.024 141.074C348.339 141.074 326.422 119.156 326.422 89.2687C326.422 59.3812 348.339 37.4636 379.024 37.4636C409.509 37.4636 431.426 59.3812 431.426 89.2687C431.426 119.156 409.509 141.074 379.024 141.074ZM379.024 119.953C395.561 119.953 406.719 107.4 406.719 89.2687C406.719 71.1369 395.561 58.5842 379.024 58.5842C362.287 58.5842 351.129 71.1369 351.129 89.2687C351.129 107.4 362.287 119.953 379.024 119.953Z',
  'M500.433 59.5804V39.0577H492.199C475.462 39.0577 441.988 49.0999 441.988 89.2687V139.48H466.496L467.243 89.2687C467.243 70.1407 472.673 59.5804 488.214 59.5804H500.433Z',
  'M255.933 0.000104096H231.24V139.452H255.933V82.5926C282.273 88.0977 302.057 111.452 302.057 139.426H325.358C325.358 109.848 309.576 83.9564 285.972 69.713C309.575 55.4697 325.358 29.5779 325.358 0H302.056C302.056 27.8862 282.15 51.2318 255.933 56.832V0.000104096Z',
  'M509.742 8.77166H534.25V39.0577H568.298V59.5804H534.25V103.415C534.25 113.577 539.629 118.758 548.795 118.758H568.298V139.48H546.006C524.088 139.48 509.742 126.728 509.742 104.412V8.77166Z',
  'M578.743 13.1152C578.762 5.86622 584.644 0 591.893 0C599.17 0 605.063 5.90915 605.044 13.1857L605.042 13.7245C605.023 20.9735 599.141 26.8397 591.892 26.8397C584.615 26.8397 578.722 20.9306 578.741 13.654L578.743 13.1152ZM579.774 139.48V39.0577H604.282V139.48H579.774Z',
  'M638.582 139.42H616.248C616.248 118.788 626.473 100.544 642.133 89.479C626.474 78.4143 616.249 60.1716 616.249 39.5397H638.583C638.583 55.3892 648.093 69.0176 661.718 75.0301C675.342 69.0176 684.852 55.3892 684.852 39.5397H707.187C707.187 60.1716 696.961 78.4143 681.302 89.479C696.962 100.544 707.188 118.788 707.188 139.42H684.853C684.853 123.571 675.343 109.943 661.718 103.93C648.092 109.943 638.582 123.571 638.582 139.42Z',
];
export const KORTIX_SYMBOL_PATH = 'M139.737 139.53H163.055C163.055 109.932 147.261 84.0225 123.642 69.7694C147.261 55.5163 163.054 29.6068 163.054 0.0085907H139.736C139.736 28.0165 119.67 51.4471 93.2921 56.9406V0.0085907H69.9773V56.9406C43.4754 51.5428 23.5331 28.1045 23.5331 0.0085907H0.215285C0.215285 29.6068 16.0088 55.5163 39.6282 69.7694C16.0086 84.0225 0.214767 109.932 0.214767 139.53H23.5325C23.5325 111.434 43.4754 87.996 69.9773 82.5981V139.556H93.2921V82.598C119.794 87.9957 139.737 111.434 139.737 139.53Z';

// The `symbol-light` brand wallpaper (apps/web/scripts/generate-wallpapers.mjs):
// the black symbol at 8.5% of the canvas width, dead centre on #FFFFFF.
// Drawn on the 2560x1600 desktop and zoomed by xfdesktop, so any size the
// viewer resizes the desktop to keeps it centred.
const WALLPAPER_W = 2560;
const WALLPAPER_H = 1600;
const SYMBOL_SCALE = (0.085 * WALLPAPER_W) / 164;
const WALLPAPER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="${WALLPAPER_W}" height="${WALLPAPER_H}" viewBox="0 0 ${WALLPAPER_W} ${WALLPAPER_H}"><rect width="100%" height="100%" fill="#FFFFFF"/><path fill="#0A0A0A" transform="translate(${(WALLPAPER_W - 164 * SYMBOL_SCALE) / 2} ${(WALLPAPER_H - 140 * SYMBOL_SCALE) / 2}) scale(${SYMBOL_SCALE})" d="${KORTIX_SYMBOL_PATH}"/></svg>`;
// Stock Greybird, plus the dock: solid white with a hairline border, and
// quiet grey hover and pressed states instead of Greybird's blue. Square
// corners: with no compositor (see xfwm4 below) a rounded corner paints black.
const THEME_CSS = `@import url("/usr/share/themes/Greybird/gtk-3.0/gtk.css");
.xfce4-panel.background { background-color: #FFFFFF; color: #0A0A0A; border: 1px solid #E5E5E5; border-bottom: none; }
.xfce4-panel.background button { border-radius: 10px; color: #0A0A0A; text-shadow: none; }
.xfce4-panel.background button:hover, .xfce4-panel.background button:active:hover, .xfce4-panel.background button:checked:hover { background-image: none; background-color: #F0F0F0; border-color: transparent; box-shadow: none; }
.xfce4-panel.background button:active, .xfce4-panel.background button:checked { background-image: none; background-color: #E5E5E5; border-color: transparent; box-shadow: none; }
`;

// voxl's MIT license, shipped with the binary as the license requires.
const VOXL_LICENSE = `MIT License

Copyright (c) 2026 Tembo

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const DIR = '/usr/share/kortix/desktop';
const BROWSER = '/usr/local/bin/kortix-desktop browser';
const XFCONF = '/etc/xdg/xfce4/xfconf/xfce-perchannel-xml';

/** xfconf properties as XML. Nested objects are groups, arrays are arrays. */
function props(o: Record<string, unknown>): string {
  const type = (v: unknown) =>
    typeof v === 'boolean' ? 'bool' : typeof v === 'string' ? 'string' : Number.isInteger(v) ? 'int' : 'double';
  return Object.entries(o)
    .map(([k, v]) =>
      Array.isArray(v)
        ? `<property name="${k}" type="array">${v.map((x) => `<value type="${type(x)}" value="${x}"/>`).join('')}</property>`
        : v && typeof v === 'object'
          ? `<property name="${k}" type="empty">${props(v as Record<string, unknown>)}</property>`
          : `<property name="${k}" type="${type(v)}" value="${v}"/>`,
    )
    .join('');
}

function channel(name: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<channel name="${name}" version="1.0">${body}</channel>\n`;
}

/**
 * The look, close to stock XFCE: Greybird, the Kortix symbol wallpaper,
 * no desktop icons, and a centred dock with three launchers (browser,
 * terminal, files). System defaults under /etc/xdg, so a user's own changes
 * in ~/.config win.
 */
export const SANDBOX_DESKTOP_FILES: Record<string, string> = {
  ['/usr/share/doc/voxl/LICENSE']: VOXL_LICENSE,
  [`${DIR}/wallpaper.svg`]: WALLPAPER_SVG,
  ['/usr/share/themes/Kortix/gtk-3.0/gtk.css']: THEME_CSS,
  [`${XFCONF}/xsettings.xml`]: channel('xsettings', props({
    Net: { ThemeName: 'Kortix', IconThemeName: 'Adwaita' },
    // voxl draws the desktop at 1.5 desktop pixels per CSS pixel (its default
    // --resize-scale), so 144 DPI shows text at its normal size, sharp.
    Xft: { DPI: 144 },
    Gtk: { FontName: 'Inter Variable 10' },
  })),
  [`${XFCONF}/xfwm4.xml`]: channel('xfwm4', props({
    general: {
      theme: 'Greybird',
      workspace_count: 1,
      // Off on purpose. voxl re-encodes only the regions X reports as damaged,
      // and under xfwm4's compositor those reports miss repaints: the stream
      // smears and keeps stale regions until a keyframe.
      use_compositing: false,
    },
  })),
  [`${XFCONF}/xfce4-desktop.xml`]: channel('xfce4-desktop', props({
    'desktop-icons': { style: 0 },
    backdrop: {
      screen0: {
        monitorscreen: {
          workspace0: { 'color-style': 0, rgba1: [1, 1, 1, 1], 'image-style': 5, 'last-image': `${DIR}/wallpaper.svg` },
        },
      },
    },
  })),
  ['/etc/xdg/xfce4/panel/default.xml']: panelXml(),
  // The dock's launchers open the browser, xfce4-terminal and Thunar without
  // asking which one to use. The browser is the agent's own (`kortix-desktop
  // browser` in apps/sandbox/entrypoint.sh): the desktop has no second one.
  ['/usr/share/xfce4/helpers/kortix-browser.desktop']: `[Desktop Entry]\nType=X-XFCE-Helper\nX-XFCE-Category=WebBrowser\nName=Browser\nIcon=web-browser\nX-XFCE-Commands=${BROWSER}\nX-XFCE-CommandsWithParameter=${BROWSER} "%s"\n`,
  ['/etc/xdg/xfce4/terminal/terminalrc']:
    '[Configuration]\nMiscMenubarDefault=FALSE\nMiscToolbarDefault=FALSE\nScrollingBar=TERMINAL_SCROLLBAR_NONE\nFontName=DejaVu Sans Mono 10\nColorForeground=#0A0A0A\nColorBackground=#FFFFFF\nColorCursor=#0A0A0A\nColorBold=#0A0A0A\nColorPalette=#0A0A0A;#C01C28;#26A269;#A2734C;#12488B;#A347BA;#2A7BDE;#D0CFCC;#5E5C64;#F66151;#33D17A;#C88800;#2A7BDE;#C061CB;#33C7DE;#FFFFFF\nMiscDefaultGeometry=100x30\n',
  ['/etc/xdg/xfce4/helpers.rc']: 'WebBrowser=kortix-browser\nTerminalEmulator=xfce4-terminal\nFileManager=thunar\n',
};

function panelXml(): string {
  const launchers = ['xfce4-web-browser.desktop', 'xfce4-terminal-emulator.desktop', 'xfce4-file-manager.desktop'];
  const ids = launchers.map((_, i) => i + 1);
  // p=10 is bottom centre; length 1 shrinks the panel to its icons: a dock.
  const panel = props({
    'dark-mode': false,
    'panel-1': { position: 'p=10;x=0;y=0', length: 1, 'position-locked': true, size: 64, 'icon-size': 40, 'plugin-ids': ids },
  });
  const plugins = launchers
    .map((item, i) => `<property name="plugin-${i + 1}" type="string" value="launcher">${props({ items: [item] })}</property>`)
    .join('');
  return channel(
    'xfce4-panel',
    `<property name="configver" type="int" value="2"/><property name="panels" type="array"><value type="int" value="1"/>${panel}</property><property name="plugins" type="empty">${plugins}</property>`,
  );
}

/** Each file as `printf <base64> | base64 -d`: no heredoc, no quoting. */
const writeFiles = Object.entries(SANDBOX_DESKTOP_FILES)
  .map(([path, body]) => `mkdir -p ${path.slice(0, path.lastIndexOf('/'))} && printf %s ${btoa(body)} | base64 -d > ${path}`)
  .join(' && ');

export const SANDBOX_DESKTOP_INSTALL_COMMAND =
  'apt-get update' +
  ' && if apt-cache show libx264-164 libyuv0 >/dev/null 2>&1; then' +
  ` apt-get install -y --no-install-recommends ${SANDBOX_DESKTOP_PACKAGES.join(' ')}` +
  ' && case "$(uname -m)" in' +
  ` x86_64) voxl_arch=amd64; voxl_sha=${VOXL_SHA256_AMD64} ;;` +
  ` aarch64|arm64) voxl_arch=arm64; voxl_sha=${VOXL_SHA256_ARM64} ;;` +
  ' *) echo "unsupported voxl architecture: $(uname -m)" >&2; exit 1 ;; esac' +
  ` && curl -fsSL --retry 3 --retry-delay 2 -o /tmp/voxl.gz "${VOXL_RELEASE_URL}/voxl-linux-\${voxl_arch}.gz"` +
  ' && echo "${voxl_sha}  /tmp/voxl.gz" | sha256sum -c -' +
  ' && gunzip -c /tmp/voxl.gz > /usr/local/bin/voxl && rm /tmp/voxl.gz && chmod 0755 /usr/local/bin/voxl' +
  " && ! ldd /usr/local/bin/voxl | grep -q 'not found'" +
  ' && ln -sf /usr/local/bin/kortix-entrypoint /usr/local/bin/kortix-desktop' +
  ` && ${writeFiles};` +
  ' else echo "desktop: skipped, this base lacks the Ubuntu 24.04 libraries voxl links"; fi' +
  ' && rm -rf /var/lib/apt/lists/*';
