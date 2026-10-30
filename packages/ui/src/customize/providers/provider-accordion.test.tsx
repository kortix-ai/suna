import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  AccordionGroupLabel,
  AccordionRowFrame,
  AccordionRowHeader,
  AccordionSubRow,
  InlineKeyField,
  type InlineKeyFieldProps,
} from './provider-accordion';
import type { ProviderListRow } from './provider-connect';

/**
 * The quick dialog's Providers section (Paper PM01 + AK01). The pure pieces
 * render under `renderToStaticMarkup` with no provider tree.
 */

const GOOGLE: ProviderListRow = {
  id: 'google',
  label: 'Google',
  method: 'key',
  modelCount: 8,
  status: 'none',
};
const OPENAI: ProviderListRow = {
  id: 'openai',
  label: 'OpenAI',
  method: 'key',
  modelCount: 8,
  status: 'connected',
};

const header = (row: ProviderListRow, expanded: boolean, addKeyHint = false) =>
  renderToStaticMarkup(
    <AccordionRowHeader
      row={row}
      meta="API key · 8 models"
      expanded={expanded}
      addKeyHint={addKeyHint}
      onToggle={() => {}}
    />,
  );

function field(overrides: Partial<InlineKeyFieldProps> = {}) {
  return renderToStaticMarkup(
    <InlineKeyField
      providerId="google"
      envVar="GOOGLE_API_KEY"
      value=""
      onValueChange={() => {}}
      onSave={() => {}}
      onCancel={() => {}}
      saving={false}
      {...overrides}
    />,
  );
}

describe('PM01 — a provider row opens in place', () => {
  test('the row is one button that reports whether it is open', () => {
    expect(header(OPENAI, false)).toMatch(/<button[^>]*aria-expanded="false"[^>]*data-accordion-row="openai"/);
    expect(header(OPENAI, true)).toMatch(/aria-expanded="true"/);
  });

  test('name and meta on the row; the connected check sits on the logo', () => {
    const out = header(OPENAI, false);
    expect(out).toContain('OpenAI');
    expect(out).toContain('API key · 8 models');
    expect(out).toContain('aria-label="Connected"');
  });

  test('an open row is a bordered card; a closed row is a plain hover row', () => {
    const open = renderToStaticMarkup(<AccordionRowFrame expanded>x</AccordionRowFrame>);
    const closed = renderToStaticMarkup(<AccordionRowFrame expanded={false}>x</AccordionRowFrame>);
    expect(open).toContain('data-accordion-frame="open"');
    expect(open).toContain('border');
    expect(closed).toContain('data-accordion-frame="closed"');
    expect(closed).toContain('hover:bg-hover');
  });

  test('a sub-row is a 40px line under a top rule, text left and action right', () => {
    const out = renderToStaticMarkup(
      <AccordionSubRow action={<button type="button">Add key</button>}>API key · not added</AccordionSubRow>,
    );
    expect(out).toContain('border-t');
    expect(out).toContain('min-h-10');
    expect(out).toContain('API key · not added');
    expect(out.indexOf('API key · not added')).toBeLessThan(out.indexOf('Add key'));
  });

  test('the group label carries its count and an optional action', () => {
    const out = renderToStaticMarkup(
      <AccordionGroupLabel label="In use · 3" action={<button type="button">search</button>} />,
    );
    expect(out).toContain('In use · 3');
    expect(out).toContain('search');
  });
});

describe('AK01 — Add key becomes a field on the row', () => {
  test('an available key row offers "Add key" on hover in place of the chevron', () => {
    const out = header(GOOGLE, false, true);
    expect(out).toContain('Add key');
    expect(out).toContain('group-hover/row:inline-flex');
  });

  test('a connected row never offers "Add key" on its header', () => {
    expect(header(OPENAI, false)).not.toContain('Add key');
  });

  test('the field is masked, monospace, and its placeholder is the env var', () => {
    const out = field();
    expect(out).toContain('type="password"');
    expect(out).toContain('placeholder="GOOGLE_API_KEY"');
    expect(out).toContain('font-mono');
    expect(out).toContain('data-1p-ignore');
  });

  test('Save stays off until there is a value', () => {
    expect(field()).toMatch(/<button[^>]*disabled=""[^>]*>Save<\/button>/);
    expect(field({ value: 'AIza-test' })).not.toMatch(/<button[^>]*disabled=""[^>]*>Save<\/button>/);
  });

  test('while saving: a spinner in Save, the field and × locked', () => {
    const out = field({ value: 'AIza-test', saving: true });
    expect(out).toMatch(/<input[^>]*disabled=""/);
    expect(out).toMatch(/<button[^>]*aria-label="Cancel"[^>]*disabled=""/);
  });

  test('an error marks the field invalid', () => {
    expect(field({ error: 'Invalid key' })).toContain('aria-invalid="true"');
    expect(field()).not.toContain('aria-invalid="true"');
  });
});
