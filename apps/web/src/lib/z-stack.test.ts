import { afterEach, describe, expect, test } from 'bun:test';

import {
  closeDialogLayer,
  dialogContentZ,
  dialogLayerLevel,
  dialogOverlayZ,
  openDialogLayer,
  removeDialogLayer,
} from './z-stack';

// The store is module-global on purpose (it has to see modals that share no
// React ancestor), so every test removes the ids it registered.
const registered = new Set<string>();
function open(id: string, minLevel = 1): number {
  registered.add(id);
  return openDialogLayer(id, minLevel);
}

afterEach(() => {
  for (const id of registered) removeDialogLayer(id);
  registered.clear();
});

describe('dialog layer stack', () => {
  test('a sibling modal opened over an open modal gets the next level', () => {
    // The reported bug: both modals mount at the app root, so React context
    // gives each depth 1 and the second overlay renders UNDER the first card.
    expect(open('first')).toBe(1);
    expect(open('second')).toBe(2);
    expect(dialogOverlayZ(2)).toBeGreaterThan(dialogContentZ(1));
  });

  test('three siblings stack in open order', () => {
    expect([open('a'), open('b'), open('c')]).toEqual([1, 2, 3]);
  });

  test('a nested modal keeps its tree floor even when nothing else is open', () => {
    expect(open('child', 2)).toBe(2);
  });

  test('a closing modal keeps its level through the exit animation', () => {
    open('below');
    open('above');
    closeDialogLayer('above');
    expect(dialogLayerLevel('above')).toBe(2);
  });

  test('a closed modal no longer raises the next one', () => {
    open('below');
    open('above');
    closeDialogLayer('above');
    expect(open('replacement')).toBe(2);
  });

  test('reopening re-levels above whatever opened meanwhile', () => {
    open('x');
    closeDialogLayer('x');
    open('y');
    expect(open('x')).toBe(2);
  });

  test('an open layer keeps its level when re-registered', () => {
    open('stable');
    open('sibling');
    expect(open('stable')).toBe(1);
  });

  test('an open layer rises when its tree floor rises', () => {
    open('grows');
    expect(open('grows', 4)).toBe(4);
  });

  test('a nested pair that opens in the same commit still puts the child on top', () => {
    // Layout effects run child-first, so the child registers before its parent.
    const child = open('child', 2);
    const parent = open('parent', 1);
    // The child's floor then follows the parent's new level via context.
    const childAfter = open('child', parent + 1);
    expect(child).toBe(2);
    expect(childAfter).toBeGreaterThan(parent);
  });

  test('removing a layer forgets it', () => {
    open('gone');
    removeDialogLayer('gone');
    expect(dialogLayerLevel('gone')).toBe(0);
  });
});
