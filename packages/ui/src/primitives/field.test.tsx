/**
 * Characterization test for the Field primitives that stay in field.tsx.
 *
 * KRTX-660 deletes field.tsx's four dead subcomponents — nothing imports
 * them and no CSS selector targets their data-slots. This file pins the
 * surviving exports' markup so that deletion is provably
 * behavior-preserving: every assertion here passed before and after the
 * change.
 *
 * `apps/web` has no browser harness, so the render-time contract is asserted
 * through SSR markup (`renderToStaticMarkup`).
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from './field';

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

describe('Field', () => {
  test('renders a vertical group by default', () => {
    const markup = render(
      <Field>
        <span>x</span>
      </Field>,
    );
    expect(markup).toContain('role="group"');
    expect(markup).toContain('data-slot="field"');
    expect(markup).toContain('data-orientation="vertical"');
    expect(markup).toContain('bg-transparent');
    expect(markup).toContain('flex-col');
  });

  test('orientation="horizontal" renders the horizontal variant', () => {
    const markup = render(<Field orientation="horizontal" />);
    expect(markup).toContain('data-orientation="horizontal"');
    expect(markup).toContain('flex-row items-center');
  });

  test('variant="outline" renders the outline variant', () => {
    const markup = render(<Field variant="outline" />);
    expect(markup).toContain('border-border rounded-md border px-3 py-2.5');
  });

  test('className reaches the rendered element', () => {
    expect(render(<Field className="mt-2" />)).toContain('mt-2');
  });
});

describe('FieldGroup', () => {
  test('renders a div with data-slot field-group', () => {
    const markup = render(
      <FieldGroup>
        <span>child</span>
      </FieldGroup>,
    );
    expect(markup.startsWith('<div data-slot="field-group"')).toBe(true);
    expect(markup).toContain('child');
    expect(markup).toContain('@container/field-group');
  });
});

describe('FieldContent', () => {
  test('renders a div with data-slot field-content', () => {
    const markup = render(
      <FieldContent>
        <span>body</span>
      </FieldContent>,
    );
    expect(markup.startsWith('<div data-slot="field-content"')).toBe(true);
    expect(markup).toContain('body');
  });
});

describe('FieldLabel', () => {
  test('renders a label element with data-slot field-label and forwards htmlFor', () => {
    const markup = render(
      <FieldLabel htmlFor="name-input">Name</FieldLabel>,
    );
    expect(markup.startsWith('<label data-slot="field-label"')).toBe(true);
    expect(markup).toContain('for="name-input"');
    expect(markup).toContain('>Name</label>');
  });
});

describe('FieldTitle', () => {
  test('renders a div with data-slot field-label (unchanged quirk)', () => {
    const markup = render(<FieldTitle>Title</FieldTitle>);
    expect(markup.startsWith('<div data-slot="field-label"')).toBe(true);
    expect(markup).toContain('>Title</div>');
  });
});

describe('FieldDescription', () => {
  test('renders a p with data-slot field-description', () => {
    const markup = render(<FieldDescription>Helper text</FieldDescription>);
    expect(markup.startsWith('<p data-slot="field-description"')).toBe(true);
    expect(markup).toContain('>Helper text</p>');
  });
});
