import { describe, expect, test } from 'bun:test';

import { EXTENSION_ORIGIN } from '@/lib/supabase/panel-cookies';
import { readPanelSessionMessage } from './panel-message';

const parent = {};
const good = { origin: EXTENSION_ORIGIN, source: parent, data: { type: 'kortix.panel.session', tokenHash: 'h' } };

describe('readPanelSessionMessage', () => {
  test('accepts the extension parent with a token hash', () => {
    expect(readPanelSessionMessage(good, parent)).toBe('h');
  });
  test('ignores another origin, another window, another type and an empty hash', () => {
    expect(readPanelSessionMessage({ ...good, origin: 'https://evil.example' }, parent)).toBeNull();
    expect(readPanelSessionMessage({ ...good, source: {} }, parent)).toBeNull();
    expect(readPanelSessionMessage({ ...good, data: { type: 'other', tokenHash: 'h' } }, parent)).toBeNull();
    expect(readPanelSessionMessage({ ...good, data: { type: 'kortix.panel.session', tokenHash: '' } }, parent)).toBeNull();
    expect(readPanelSessionMessage({ ...good, data: null }, parent)).toBeNull();
  });
});
