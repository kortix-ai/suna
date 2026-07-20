import { describe, expect, test } from 'bun:test';

import {
  COMPOSER_PILL_ACTIVE_CLASS,
  COMPOSER_PILL_TRIGGER_CLASS,
  COMPOSER_TOOLBAR_SCROLL_ZONE_CLASS,
} from './composer-pill';

describe('composer pill trigger contract', () => {
  test('pills are shrink-0 — the mobile toolbar row scrolls horizontally instead of squishing them', () => {
    expect(COMPOSER_PILL_TRIGGER_CLASS.split(' ')).toContain('shrink-0');
  });

  test('pill height and press feedback stay pinned across every selector', () => {
    const classes = COMPOSER_PILL_TRIGGER_CLASS.split(' ');
    expect(classes).toContain('h-8');
    expect(classes).toContain('active:scale-[0.96]');
    expect(COMPOSER_PILL_TRIGGER_CLASS).toContain('transition-[color,background-color,transform]');
  });

  test('active state highlights with the selection tint, never bg-muted', () => {
    expect(COMPOSER_PILL_ACTIVE_CLASS).toContain('bg-primary/[0.06]');
  });

  test('toolbar zones scroll on phones and never rigidly reserve width — a wide toolbarSlot must not push send/stop out of the card', () => {
    const classes = COMPOSER_TOOLBAR_SCROLL_ZONE_CLASS.split(' ');
    expect(classes).toContain('min-w-0');
    expect(classes).toContain('overflow-x-auto');
    expect(classes).toContain('sm:overflow-visible');
    expect(classes).toContain('[scrollbar-width:none]');
    expect(classes).not.toContain('shrink-0');
  });
});
