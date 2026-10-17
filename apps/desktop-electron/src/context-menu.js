// The right-click menu for the app's web content: the menu every browser and
// native text field has. Without a `context-menu` handler Chromium shows
// nothing, so a right-click in the composer, the chat or on a link did nothing
// (KRTX-2555). A page that draws its own menu calls `preventDefault` on the
// DOM `contextmenu` event, and then Chromium sends this handler nothing.

const MAX_SUGGESTIONS = 5;

/** Only a web or mail link goes to the system browser. */
function openableLink(url) {
  return /^(https?|mailto):/i.test(url);
}

/**
 * The menu for one right-click, from Electron's `context-menu` params, in the
 * order a browser shows it: spelling, link, image, then the edit menu (or
 * Copy for selected text). `actions` runs what an Electron role cannot.
 * Empty when there is nothing to offer, such as a plain area of the page.
 */
function contextMenuTemplate(params, actions) {
  const flags = params.editFlags ?? {};
  const sections = [];
  if (params.misspelledWord) {
    const suggestions = (params.dictionarySuggestions ?? []).slice(0, MAX_SUGGESTIONS);
    sections.push([
      ...(suggestions.length
        ? suggestions.map((word) => ({ label: word, click: () => actions.replaceMisspelling(word) }))
        : [{ label: 'No Guesses Found', enabled: false }]),
      { label: 'Add to Dictionary', click: () => actions.addToDictionary(params.misspelledWord) },
    ]);
  }
  if (params.linkURL) {
    sections.push([
      ...(openableLink(params.linkURL)
        ? [{ label: 'Open Link in Browser', click: () => actions.openExternal(params.linkURL) }]
        : []),
      { label: 'Copy Link', click: () => actions.copyText(params.linkURL) },
    ]);
  }
  if (params.mediaType === 'image' && params.srcURL) {
    sections.push([
      { label: 'Copy Image', click: () => actions.copyImageAt(params.x, params.y) },
      { label: 'Copy Image Address', click: () => actions.copyText(params.srcURL) },
    ]);
  }
  if (params.isEditable) {
    sections.push(
      [
        { role: 'undo', enabled: Boolean(flags.canUndo) },
        { role: 'redo', enabled: Boolean(flags.canRedo) },
      ],
      [
        { role: 'cut', enabled: Boolean(flags.canCut) },
        { role: 'copy', enabled: Boolean(flags.canCopy) },
        { role: 'paste', enabled: Boolean(flags.canPaste) },
        { role: 'pasteAndMatchStyle', enabled: Boolean(flags.canPaste) },
      ],
      [{ role: 'selectAll', enabled: Boolean(flags.canSelectAll) }],
    );
  } else if (params.selectionText?.trim()) {
    sections.push([{ role: 'copy', enabled: Boolean(flags.canCopy) }]);
  }
  return sections.flatMap((section, index) => (index === 0 ? section : [{ type: 'separator' }, ...section]));
}

/** Show `contextMenuTemplate` on every right-click in `webContents`. */
function attachContextMenu(webContents, { Menu, shell, clipboard, getWindow }) {
  webContents.on('context-menu', (_event, params) => {
    const template = contextMenuTemplate(params, {
      replaceMisspelling: (word) => webContents.replaceMisspelling(word),
      addToDictionary: (word) => webContents.session.addWordToSpellCheckerDictionary(word),
      openExternal: (url) => shell.openExternal(url),
      copyText: (text) => clipboard.writeText(text),
      copyImageAt: (x, y) => webContents.copyImageAt(x, y),
    });
    if (template.length === 0) return;
    Menu.buildFromTemplate(template).popup({ window: getWindow() ?? undefined });
  });
}

module.exports = { attachContextMenu, contextMenuTemplate };
