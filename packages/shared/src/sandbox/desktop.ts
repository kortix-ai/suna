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
  'libopus0',
  'libpulse0',
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
] as const;

const CHROMIUM = '/home/kortix/.local/bin/chromium --no-sandbox --no-first-run --no-default-browser-check';

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
  // The panel's Web Browser and Terminal launchers open Chromium and
  // xfce4-terminal without asking which one to use.
  ' && mkdir -p /usr/share/xfce4/helpers /etc/xdg/xfce4' +
  ` && printf '[Desktop Entry]\\nType=X-XFCE-Helper\\nX-XFCE-Category=WebBrowser\\nName=Chromium\\nIcon=web-browser\\nX-XFCE-Commands=${CHROMIUM}\\nX-XFCE-CommandsWithParameter=${CHROMIUM} "%%s"\\n' > /usr/share/xfce4/helpers/kortix-chromium.desktop` +
  " && printf 'WebBrowser=kortix-chromium\\nTerminalEmulator=xfce4-terminal\\n' > /etc/xdg/xfce4/helpers.rc;" +
  ' else echo "desktop: skipped, this base lacks the Ubuntu 24.04 libraries voxl links"; fi' +
  ' && rm -rf /var/lib/apt/lists/*';
