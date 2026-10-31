import { describe, expect, test } from 'bun:test';

import {
  boardKeyAction,
  moveBoardSelection,
  parseBoardInput,
  parseDispatch,
  sessionsLayoutOf,
  withSessionsLayout,
} from './board-dispatch';

const AGENTS = ['reviewer', 'Writer', 'mykortix'];

describe('parseDispatch', () => {
  test('a plain prompt starts a session with the project default agent', () => {
    expect(parseDispatch('fix the flaky login test', AGENTS)).toEqual({ kind: 'dispatch', prompt: 'fix the flaky login test' });
  });

  test('@agent as the first word runs that agent with the rest as the prompt', () => {
    expect(parseDispatch('@reviewer check the auth module', AGENTS)).toEqual({
      kind: 'dispatch',
      prompt: 'check the auth module',
      agent: 'reviewer',
    });
    // Any case; the agent's own spelling comes back.
    expect(parseDispatch('@writer draft the release notes', AGENTS)).toMatchObject({ agent: 'Writer' });
  });

  test('a first word that names a project agent runs that agent', () => {
    expect(parseDispatch('reviewer check the auth module', AGENTS)).toEqual({
      kind: 'dispatch',
      prompt: 'check the auth module',
      agent: 'reviewer',
    });
  });

  test('an @word that names no agent stays prompt text', () => {
    expect(parseDispatch('@nobody look at this', AGENTS)).toEqual({ kind: 'dispatch', prompt: '@nobody look at this' });
  });

  test('a lone agent name is a prompt, not an agent with no task', () => {
    expect(parseDispatch('reviewer', AGENTS)).toEqual({ kind: 'dispatch', prompt: 'reviewer' });
  });

  test('under 4 characters is too short, also after the agent name', () => {
    expect(parseDispatch('hi', AGENTS)).toEqual({ kind: 'too_short' });
    expect(parseDispatch('  abc  ', AGENTS)).toEqual({ kind: 'too_short' });
    expect(parseDispatch('abcd', AGENTS)).toMatchObject({ kind: 'dispatch' });
    expect(parseDispatch('@reviewer ok', AGENTS)).toEqual({ kind: 'too_short' });
    expect(parseDispatch('   ', AGENTS)).toEqual({ kind: 'empty' });
  });
});

describe('parseBoardInput', () => {
  test('leading s: and a: tokens filter; the rest is the prompt', () => {
    expect(parseBoardInput('s:working a:reviewer')).toEqual({ states: ['working'], agents: ['reviewer'], rest: '' });
    expect(parseBoardInput('s:blocked fix it now')).toEqual({ states: ['needs_input'], agents: [], rest: 'fix it now' });
    expect(parseBoardInput('s:ended')).toEqual({ states: ['failed', 'stopped'], agents: [], rest: '' });
  });

  test('a token after the prompt starts, or an unknown state, is prompt text', () => {
    expect(parseBoardInput('fix s:working')).toEqual({ states: [], agents: [], rest: 'fix s:working' });
    expect(parseBoardInput('s:sleepy fix it')).toEqual({ states: [], agents: [], rest: 's:sleepy fix it' });
  });
});

describe('boardKeyAction', () => {
  const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({ key: k, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods });
  const row = { tagName: 'DIV' };

  test('maps the board keys', () => {
    expect(boardKeyAction(key('ArrowUp'), row)).toBe('up');
    expect(boardKeyAction(key('ArrowDown'), row)).toBe('down');
    expect(boardKeyAction(key(' '), row)).toBe('peek');
    expect(boardKeyAction(key('Enter'), row)).toBe('open');
    expect(boardKeyAction(key('x'), row)).toBe('stop');
    expect(boardKeyAction(key('Escape'), row)).toBe('close');
    expect(boardKeyAction(key('a'), row)).toBeNull();
  });

  test('a key typed into a field or with a modifier is not the board\'s', () => {
    expect(boardKeyAction(key('x'), { tagName: 'INPUT' })).toBeNull();
    expect(boardKeyAction(key(' '), { tagName: 'TEXTAREA' })).toBeNull();
    expect(boardKeyAction(key('Enter'), { isContentEditable: true })).toBeNull();
    expect(boardKeyAction(key('x', { metaKey: true }), row)).toBeNull();
    expect(boardKeyAction(key('X', { shiftKey: true }), row)).toBeNull();
    // A focused row button answers Enter and Space itself; the arrows still move.
    expect(boardKeyAction(key('Enter'), { tagName: 'BUTTON' })).toBeNull();
    expect(boardKeyAction(key(' '), { tagName: 'A' })).toBeNull();
    expect(boardKeyAction(key('ArrowDown'), { tagName: 'BUTTON' })).toBe('down');
  });
});

describe('moveBoardSelection', () => {
  const order = ['a', 'b', 'c'];
  test('moves inside the list and stops at its ends', () => {
    expect(moveBoardSelection(order, null, 1)).toBe('a');
    expect(moveBoardSelection(order, null, -1)).toBe('c');
    expect(moveBoardSelection(order, 'a', 1)).toBe('b');
    expect(moveBoardSelection(order, 'c', 1)).toBe('c');
    expect(moveBoardSelection(order, 'a', -1)).toBe('a');
    expect(moveBoardSelection(order, 'gone', 1)).toBe('a');
    expect(moveBoardSelection([], 'a', 1)).toBeNull();
  });
});

describe('List/Board toggle', () => {
  test('?view=board is the board, anything else the list', () => {
    expect(sessionsLayoutOf('board')).toBe('board');
    expect(sessionsLayoutOf('archived')).toBe('list');
    expect(sessionsLayoutOf(null)).toBe('list');
  });

  test('the toggle writes view=board and removes only its own value', () => {
    expect(withSessionsLayout('', 'board')).toBe('view=board');
    expect(withSessionsLayout('view=board&q=x', 'list')).toBe('q=x');
    expect(withSessionsLayout('view=archived', 'list')).toBe('view=archived');
    expect(withSessionsLayout('view=archived', 'board')).toBe('view=board');
  });
});
