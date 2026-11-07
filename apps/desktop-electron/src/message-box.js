const { dialog } = require('electron');

/** A native message box on `parent` while it is alive, else ownerless. */
function showMessage(options, parent) {
  return parent && !parent.isDestroyed() ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
}

module.exports = { showMessage };
