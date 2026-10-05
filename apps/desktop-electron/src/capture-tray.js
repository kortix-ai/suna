// Kortix Capture's own menu bar item: shown once Capture is set up on this
// computer, apart from the computer agent's tray (computer-tray.js). Its
// items come from capture.js (captureTrayItems); this file owns the Tray.

const path = require('node:path');
const { Menu, Tray, app, nativeImage } = require('electron');

/**
 * @param {{
 *   items: () => object[],
 *   keepsRunning: () => boolean,
 *   open: () => void,
 * }} deps
 */
function setupCaptureTray(deps) {
  /** @type {import('electron').Tray | null} */
  let tray = null;

  function icon() {
    const dir = path.join(__dirname, '..', 'assets', 'capture-tray');
    if (process.platform === 'darwin') {
      const image = nativeImage.createFromPath(path.join(dir, 'captureTemplate.png'));
      image.setTemplateImage(true);
      return image;
    }
    return nativeImage.createFromPath(path.join(dir, process.platform === 'win32' ? 'capture.ico' : 'capture.png'));
  }

  function render() {
    const items = deps.items();
    if (items.length === 0) {
      tray?.destroy();
      tray = null;
      return;
    }
    if (!tray) {
      tray = new Tray(icon());
      // Windows and Linux: a left click opens Capture; the menu is on right click.
      if (process.platform !== 'darwin') tray.on('click', deps.open);
    }
    const status = items.find((item) => item.id === 'capture-status')?.label;
    tray.setToolTip(status ? `Kortix Capture — ${status}` : 'Kortix Capture');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        ...items,
        { type: 'separator' },
        {
          id: 'capture-quit',
          label: deps.keepsRunning() ? 'Quit Kortix (Kortix Capture keeps recording)' : 'Quit Kortix',
          click: () => app.quit(),
        },
      ]),
    );
  }

  return {
    render() {
      try {
        render();
      } catch (error) {
        console.warn(`[kortix] capture tray update failed: ${error}`);
      }
    },
  };
}

module.exports = { setupCaptureTray };
