import { describe, expect, test } from 'bun:test';

import { INITIAL_FORM_STATE, buildProvisionPayload, isSubmittable } from './new-workspace-form';

describe('INITIAL_FORM_STATE', () => {
  test('defaults to a Kortix-managed repo on main, with no icon', () => {
    expect(INITIAL_FORM_STATE).toEqual({
      name: '',
      icon: null,
      source: 'managed',
      defaultBranch: 'main',
      templateId: null,
      accountId: null,
      // The two GitHub sources need an installation, and `github-import`
      // additionally a repository. Null on a `managed` default, where neither
      // is read — but present in the shape, so `isSubmittable`'s
      // `githubSourceReady` gate reads a defined field rather than
      // `undefined`.
      installationId: null,
      repoFullName: null,
    });
  });
});

describe('isSubmittable — one form, no account to pick', () => {
  test('false while the name is empty', () => {
    expect(isSubmittable(INITIAL_FORM_STATE)).toBe(false);
  });

  test('true with a valid name: the managed source needs no account', () => {
    expect(isSubmittable({ ...INITIAL_FORM_STATE, name: 'suna-web' })).toBe(true);
  });

  test('false when the name breaks the charset rule', () => {
    expect(isSubmittable({ ...INITIAL_FORM_STATE, name: 'my/agi' })).toBe(false);
  });

  test('a GitHub source needs the account its installation lives in', () => {
    const github = {
      ...INITIAL_FORM_STATE,
      name: 'suna-web',
      source: 'github-create' as const,
      installationId: '84',
    };
    expect(isSubmittable(github)).toBe(false);
    expect(isSubmittable({ ...github, accountId: 'a1' })).toBe(true);
  });
});

describe('buildProvisionPayload', () => {
  test('sends the trimmed name and seeds the starter', () => {
    const payload = buildProvisionPayload({ ...INITIAL_FORM_STATE, name: '  suna-web  ' });
    expect(payload.name).toBe('suna-web');
    expect(payload.seed_starter).toBe(true);
  });

  test('omits icon keys entirely when no icon is picked', () => {
    const payload = buildProvisionPayload({ ...INITIAL_FORM_STATE, name: 'x' });
    expect('icon' in payload).toBe(false);
    expect('icon_glyph' in payload).toBe(false);
  });

  test('sends icon for an emoji and never both icon keys', () => {
    const payload = buildProvisionPayload({
      ...INITIAL_FORM_STATE,
      name: 'x',
      icon: { emoji: '\u{1F680}' },
    });
    expect(payload.icon).toBe('\u{1F680}');
    expect('icon_glyph' in payload).toBe(false);
  });

  test('sends icon_glyph for a glyph and never both icon keys', () => {
    const payload = buildProvisionPayload({
      ...INITIAL_FORM_STATE,
      name: 'x',
      icon: { glyph: { name: 'Rocket', color: 'green' } },
    });
    expect(payload.icon_glyph).toEqual({ name: 'Rocket', color: 'green' });
    expect('icon' in payload).toBe(false);
  });

  test('sends source_item_id only when a template is chosen', () => {
    expect('source_item_id' in buildProvisionPayload({ ...INITIAL_FORM_STATE, name: 'x' })).toBe(
      false,
    );
    expect(
      buildProvisionPayload({ ...INITIAL_FORM_STATE, name: 'x', templateId: 'item-1' })
        .source_item_id,
    ).toBe('item-1');
  });

  test('never sends account_id: the server picks the account for a new workspace', () => {
    expect('account_id' in buildProvisionPayload({ ...INITIAL_FORM_STATE, name: 'x' })).toBe(false);
    expect('account_id' in buildProvisionPayload({ ...INITIAL_FORM_STATE, name: 'x', accountId: 'a1' })).toBe(
      false,
    );
  });
});
