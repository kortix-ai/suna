const { describe, it, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createInstanceStore, OVERRIDE_FILE, SETUP_PENDING_FILE } = require('./instance-store');

const DEFAULT_URL = 'https://kortix.com/projects';
const CUSTOM_URL = 'https://kortix.acme.com/projects';

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kortix-instance-store-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const profile = (name = 'profile') => path.join(root, name);
const store = (dir, envUrl) => createInstanceStore({ dir, envUrl, defaultUrl: DEFAULT_URL });

describe('markIfNewProfile', () => {
  it('marks a profile directory that does not exist yet', () => {
    const dir = profile();
    expect(store(dir).markIfNewProfile()).toBe(true);
    expect(fs.existsSync(path.join(dir, SETUP_PENDING_FILE))).toBe(true);
  });

  it('marks an empty profile, and one that holds only .DS_Store', () => {
    const empty = profile('empty');
    fs.mkdirSync(empty);
    expect(store(empty).markIfNewProfile()).toBe(true);

    const finder = profile('finder');
    fs.mkdirSync(finder);
    fs.writeFileSync(path.join(finder, '.DS_Store'), '');
    expect(store(finder).markIfNewProfile()).toBe(true);
  });

  it('never marks a profile an earlier launch used (upgrade path)', () => {
    const dir = profile();
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'Preferences'), '{}');
    expect(store(dir).markIfNewProfile()).toBe(false);
    expect(fs.existsSync(path.join(dir, SETUP_PENDING_FILE))).toBe(false);
  });
});

describe('needsSetup', () => {
  it('asks a marked profile where nothing chose a URL', () => {
    const s = store(profile());
    s.markIfNewProfile();
    expect(s.needsSetup()).toBe(true);
  });

  it('does not ask an unmarked profile', () => {
    expect(store(profile()).needsSetup()).toBe(false);
  });

  it('does not ask when KORTIX_DESKTOP_URL or a saved URL already chose', () => {
    const dir = profile();
    store(dir).markIfNewProfile();
    expect(store(dir, 'http://localhost:3000/projects').needsSetup()).toBe(false);

    fs.writeFileSync(path.join(dir, OVERRIDE_FILE), CUSTOM_URL);
    expect(store(dir).needsSetup()).toBe(false);
  });
});

describe('URL precedence', () => {
  it('loads the saved URL, then KORTIX_DESKTOP_URL, then the build default', () => {
    const dir = profile();
    fs.mkdirSync(dir);
    expect(store(dir).appUrl()).toBe(DEFAULT_URL);
    expect(store(dir, 'http://localhost:3000/projects').appUrl()).toBe('http://localhost:3000/projects');

    fs.writeFileSync(path.join(dir, OVERRIDE_FILE), ` ${CUSTOM_URL}\n`);
    const s = store(dir, 'http://localhost:3000/projects');
    expect(s.override()).toBe(CUSTOM_URL);
    expect(s.appUrl()).toBe(CUSTOM_URL);
    expect(s.baseUrl()).toBe('http://localhost:3000/projects');
  });

  it('ignores an empty frontend_url', () => {
    const dir = profile();
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, OVERRIDE_FILE), '\n');
    expect(store(dir).override()).toBeNull();
    expect(store(dir).appUrl()).toBe(DEFAULT_URL);
  });
});

describe('save', () => {
  it('saves a custom URL and completes setup', () => {
    const dir = profile();
    const s = store(dir);
    s.markIfNewProfile();
    expect(s.save({ kind: 'custom', url: CUSTOM_URL })).toBeNull();
    expect(fs.readFileSync(path.join(dir, OVERRIDE_FILE), 'utf8')).toBe(CUSTOM_URL);
    expect(s.appUrl()).toBe(CUSTOM_URL);
    expect(s.needsSetup()).toBe(false);
  });

  it('saves the default by removing frontend_url, and completes setup', () => {
    const dir = profile();
    const s = store(dir);
    s.markIfNewProfile();
    s.save({ kind: 'custom', url: CUSTOM_URL });
    fs.writeFileSync(path.join(dir, SETUP_PENDING_FILE), 'again');

    expect(s.save({ kind: 'default' })).toBeNull();
    expect(fs.existsSync(path.join(dir, OVERRIDE_FILE))).toBe(false);
    expect(fs.existsSync(path.join(dir, SETUP_PENDING_FILE))).toBe(false);
    expect(s.appUrl()).toBe(DEFAULT_URL);
    expect(s.needsSetup()).toBe(false);
  });

  it('keeps asking when the URL cannot be saved', () => {
    const dir = profile();
    const s = store(dir);
    s.markIfNewProfile();
    fs.mkdirSync(path.join(dir, OVERRIDE_FILE)); // a directory where the file must go

    expect(s.save({ kind: 'custom', url: CUSTOM_URL })).toContain('EISDIR');
    expect(fs.existsSync(path.join(dir, SETUP_PENDING_FILE))).toBe(true);
  });
});
