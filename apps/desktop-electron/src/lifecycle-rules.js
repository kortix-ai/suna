function needsMainWindow(mainWindow) {
  return !mainWindow || mainWindow.isDestroyed();
}

function shouldAllowPreventedUnload(response) {
  return response === 0;
}

function revealMainWindow(mainWindow) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

module.exports = { needsMainWindow, revealMainWindow, shouldAllowPreventedUnload };
