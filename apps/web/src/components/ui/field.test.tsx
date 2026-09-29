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

// Characterization of the live `field.tsx` surface. It pins the six components
// that have consumers, so a change to this file cannot silently drop a shared
// import or a rendered slot.
describe('Field primitives', () => {
  test('Field renders the group slot, orientation and variant, and forwards props', () => {
    const html = renderToStaticMarkup(
      <Field
        orientation="horizontal"
        variant="outline"
        className="rounded-none"
        data-testid="field"
      />,
    );
    expect(html).toContain('role="group"');
    expect(html).toContain('data-slot="field"');
    expect(html).toContain('data-orientation="horizontal"');
    expect(html).toContain('border-border');
    expect(html).toContain('rounded-none');
    expect(html).toContain('data-testid="field"');
  });

  test('Field defaults to a vertical transparent layout', () => {
    const html = renderToStaticMarkup(<Field />);
    expect(html).toContain('data-orientation="vertical"');
    expect(html).toContain('flex-col');
    expect(html).toContain('bg-transparent');
  });

  test('FieldGroup, FieldContent, FieldTitle and FieldDescription keep their slots', () => {
    const html = renderToStaticMarkup(
      <FieldGroup className="group-x">
        <FieldContent className="content-x">
          <FieldTitle className="title-x">Title</FieldTitle>
          <FieldDescription className="description-x">Description</FieldDescription>
        </FieldContent>
      </FieldGroup>,
    );
    expect(html).toContain('data-slot="field-group"');
    expect(html).toContain('group/field-group');
    expect(html).toContain('group-x');
    expect(html).toContain('data-slot="field-content"');
    expect(html).toContain('content-x');
    expect(html).toContain('data-slot="field-label"');
    expect(html).toContain('title-x');
    expect(html).toContain('data-slot="field-description"');
    expect(html).toContain('description-x');
    expect(html).toContain('>Title</div>');
    expect(html).toContain('>Description</p>');
  });

  test('FieldLabel renders the label slot with the caller className', () => {
    const html = renderToStaticMarkup(
      <FieldLabel className="label-x" htmlFor="email">
        Email
      </FieldLabel>,
    );
    expect(html).toContain('data-slot="field-label"');
    expect(html).toContain('for="email"');
    expect(html).toContain('label-x');
    expect(html).toContain('>Email</label>');
  });
});
