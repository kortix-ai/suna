import { describe, expect, test } from 'bun:test';

import { fileIconKey } from './file-icon';

describe('fileIconKey', () => {
  test('each web language gets its own glyph', () => {
    expect(fileIconKey('App.tsx')).toBe('tsx');
    expect(fileIconKey('index.ts')).toBe('ts');
    expect(fileIconKey('main.js')).toBe('js');
    expect(fileIconKey('Card.jsx')).toBe('jsx');
    expect(fileIconKey('page.html')).toBe('html');
    expect(fileIconKey('style.css')).toBe('css');
    expect(fileIconKey('style.scss')).toBe('css');
    expect(fileIconKey('Widget.vue')).toBe('vue');
  });

  test('other languages and data formats', () => {
    expect(fileIconKey('app.py')).toBe('py');
    expect(fileIconKey('lib.rs')).toBe('rs');
    expect(fileIconKey('main.c')).toBe('c');
    expect(fileIconKey('main.cpp')).toBe('cpp');
    expect(fileIconKey('schema.sql')).toBe('sql');
    expect(fileIconKey('data.csv')).toBe('csv');
    expect(fileIconKey('README.md')).toBe('md');
    expect(fileIconKey('notes.txt')).toBe('txt');
    expect(fileIconKey('config.yaml')).toBe('ini');
    expect(fileIconKey('settings.json')).toBe('code');
  });

  test('the Kortix files get the Kortix mark', () => {
    expect(fileIconKey('kortix.html')).toBe('kortix');
    expect(fileIconKey('kortix.yaml')).toBe('kortix');
    expect(fileIconKey('KORTIX.md')).toBe('kortix');
  });

  test('git files get the git glyph', () => {
    expect(fileIconKey('.gitignore')).toBe('git');
    expect(fileIconKey('.gitattributes')).toBe('git');
    expect(fileIconKey('.gitmodules')).toBe('git');
  });

  test('images, archives, documents, and the rest', () => {
    expect(fileIconKey('logo.png')).toBe('png');
    expect(fileIconKey('photo.jpeg')).toBe('jpg');
    expect(fileIconKey('mark.svg')).toBe('svg');
    expect(fileIconKey('bundle.zip')).toBe('zip');
    expect(fileIconKey('paper.pdf')).toBe('pdf');
    expect(fileIconKey('deck.pptx')).toBe('ppt');
    expect(fileIconKey('sheet.xlsx')).toBe('xls');
    expect(fileIconKey('.env')).toBe('lock');
    expect(fileIconKey('Dockerfile')).toBe('archive');
    expect(fileIconKey('deploy.sh')).toBe('terminal');
    expect(fileIconKey('mystery.xyz')).toBe('file');
  });
});

describe('displayNames', () => {
  test('drops the extension', () => {
    const { displayNames } = require('./file-icon');
    expect(displayNames(['package.json', 'README.md'])).toEqual({ 'package.json': 'package', 'README.md': 'README' });
  });

  test('keeps the extension on names that would collide once bare', () => {
    const { displayNames } = require('./file-icon');
    expect(displayNames(['kortix.html', 'kortix.yaml', 'index.ts'])).toEqual({
      'kortix.html': 'kortix.html',
      'kortix.yaml': 'kortix.yaml',
      'index.ts': 'index',
    });
  });

  test('a dotfile keeps its whole name', () => {
    const { displayNames } = require('./file-icon');
    expect(displayNames(['.env', '.gitignore'])).toEqual({ '.env': '.env', '.gitignore': '.gitignore' });
  });
});
