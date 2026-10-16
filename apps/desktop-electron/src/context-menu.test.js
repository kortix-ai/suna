const { describe, it, expect } = require('bun:test');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const { attachContextMenu, contextMenuTemplate } = require('./context-menu');

// KRTX-2555: the shell handled no `context-menu` event, so a right-click in the
// composer, the chat or on a link showed nothing. No paste with the mouse, no
// spelling fix, no copy of a link or an image.

const PLAIN = {
  x: 10,
  y: 20,
  linkURL: '',
  srcURL: '',
  mediaType: 'none',
  isEditable: false,
  selectionText: '',
  misspelledWord: '',
  dictionarySuggestions: [],
  editFlags: {},
};

function recordingActions() {
  const calls = [];
  const actions = {
    replaceMisspelling: (word) => calls.push(['replace', word]),
    addToDictionary: (word) => calls.push(['dictionary', word]),
    openExternal: (url) => calls.push(['open', url]),
    copyText: (text) => calls.push(['copy', text]),
    copyImageAt: (x, y) => calls.push(['copy-image', x, y]),
  };
  return { calls, actions };
}

/** What a person reads: role names and labels, `-` for a separator. */
function shape(template) {
  return template.map((item) => (item.type === 'separator' ? '-' : item.role ?? item.label));
}

describe('contextMenuTemplate', () => {
  it('a text field gets the edit menu, each item enabled as the field allows', () => {
    const template = contextMenuTemplate(
      {
        ...PLAIN,
        isEditable: true,
        editFlags: { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: true, canSelectAll: true },
      },
      recordingActions().actions,
    );
    expect(shape(template)).toEqual(['undo', 'redo', '-', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', '-', 'selectAll']);
    const enabled = Object.fromEntries(template.filter((item) => item.role).map((item) => [item.role, item.enabled]));
    expect(enabled).toEqual({
      undo: false,
      redo: false,
      cut: false,
      copy: false,
      paste: true,
      pasteAndMatchStyle: true,
      selectAll: true,
    });
  });

  it('a misspelled word offers its suggestions and Add to Dictionary above the edit menu', () => {
    const { calls, actions } = recordingActions();
    const template = contextMenuTemplate(
      {
        ...PLAIN,
        isEditable: true,
        misspelledWord: 'recieve',
        dictionarySuggestions: ['receive', 'relieve', 'recite', 'reprieve', 'receiver', 'deceive'],
        editFlags: { canPaste: true },
      },
      actions,
    );
    expect(shape(template).slice(0, 7)).toEqual([
      'receive',
      'relieve',
      'recite',
      'reprieve',
      'receiver',
      'Add to Dictionary',
      '-',
    ]);
    template[0].click();
    template[5].click();
    expect(calls).toEqual([
      ['replace', 'receive'],
      ['dictionary', 'recieve'],
    ]);
  });

  it('a misspelled word with no suggestions says so', () => {
    const template = contextMenuTemplate(
      { ...PLAIN, isEditable: true, misspelledWord: 'qzxv', dictionarySuggestions: [] },
      recordingActions().actions,
    );
    expect(template[0]).toEqual({ label: 'No Guesses Found', enabled: false });
  });

  it('a web link can be opened in the browser and copied', () => {
    const { calls, actions } = recordingActions();
    const template = contextMenuTemplate({ ...PLAIN, linkURL: 'https://example.com/docs' }, actions);
    expect(shape(template)).toEqual(['Open Link in Browser', 'Copy Link']);
    for (const item of template) item.click();
    expect(calls).toEqual([
      ['open', 'https://example.com/docs'],
      ['copy', 'https://example.com/docs'],
    ]);
  });

  it('a link that is not a web or mail link is only copied, never opened', () => {
    const template = contextMenuTemplate(
      { ...PLAIN, linkURL: 'javascript:alert(1)' },
      recordingActions().actions,
    );
    expect(shape(template)).toEqual(['Copy Link']);
  });

  it('an image can be copied, and its address too', () => {
    const { calls, actions } = recordingActions();
    const template = contextMenuTemplate(
      { ...PLAIN, mediaType: 'image', srcURL: 'https://cdn.example.com/a.png' },
      actions,
    );
    expect(shape(template)).toEqual(['Copy Image', 'Copy Image Address']);
    for (const item of template) item.click();
    expect(calls).toEqual([
      ['copy-image', 10, 20],
      ['copy', 'https://cdn.example.com/a.png'],
    ]);
  });

  it('selected text outside a field can be copied', () => {
    const template = contextMenuTemplate(
      { ...PLAIN, selectionText: 'a sentence', editFlags: { canCopy: true } },
      recordingActions().actions,
    );
    expect(shape(template)).toEqual(['copy']);
  });

  it('a plain area of the page shows no menu', () => {
    expect(contextMenuTemplate(PLAIN, recordingActions().actions)).toEqual([]);
    expect(contextMenuTemplate({ ...PLAIN, selectionText: '   ' }, recordingActions().actions)).toEqual([]);
  });
});

describe('attachContextMenu', () => {
  function fakeElectron() {
    const popups = [];
    const built = [];
    const Menu = {
      buildFromTemplate: (template) => {
        built.push(template);
        return { popup: (options) => popups.push(options) };
      },
    };
    const webContents = new EventEmitter();
    webContents.replaceMisspelling = () => undefined;
    webContents.copyImageAt = () => undefined;
    webContents.session = { addWordToSpellCheckerDictionary: () => true };
    return { popups, built, Menu, webContents };
  }

  it('pops the menu up over the window that was right-clicked', () => {
    const { popups, built, Menu, webContents } = fakeElectron();
    const window = { id: 'main' };
    attachContextMenu(webContents, { Menu, shell: {}, clipboard: {}, getWindow: () => window });
    webContents.emit('context-menu', {}, { ...PLAIN, isEditable: true, editFlags: { canPaste: true } });
    expect(shape(built[0])).toContain('paste');
    expect(popups).toEqual([{ window }]);
  });

  it('shows nothing where there is nothing to offer', () => {
    const { popups, Menu, webContents } = fakeElectron();
    attachContextMenu(webContents, { Menu, shell: {}, clipboard: {}, getWindow: () => null });
    webContents.emit('context-menu', {}, PLAIN);
    expect(popups).toEqual([]);
  });

  it('is wired to the app window and the Quick Entry bar', () => {
    const main = readFileSync(join(__dirname, 'main.js'), 'utf8');
    const quickEntry = readFileSync(join(__dirname, 'quick-entry.js'), 'utf8');
    expect(main).toContain('attachContextMenu(mainWindow.webContents');
    expect(quickEntry).toContain('attachContextMenu(bar.webContents');
  });
});
