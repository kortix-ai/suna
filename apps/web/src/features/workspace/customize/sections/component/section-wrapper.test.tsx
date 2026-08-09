import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import CustomizeSectionWrapper from './section-wrapper';

const render = (mode: 'default' | 'fill', extra: { docs?: string; action?: ReactNode }) =>
  renderToStaticMarkup(
    <CustomizeSectionWrapper
      title="Title"
      description="Description"
      fill={mode === 'fill'}
      {...extra}
    >
      <div>Body</div>
    </CustomizeSectionWrapper>,
  );

describe('CustomizeSectionWrapper heading — default mode', () => {
  test('renders the docs link before the action when both are given', () => {
    const html = render('default', {
      docs: 'https://example.com',
      action: <button type="button">Save</button>,
    });
    expect(html).toContain('Learn more.');
    expect(html).toContain('Save');
    expect(html.indexOf('Learn more.')).toBeLessThan(html.indexOf('Save'));
  });

  test('renders the docs link when there is no action', () => {
    const html = render('default', { docs: 'https://example.com' });
    expect(html).toContain('Learn more.');
  });

  test('renders no docs link when docs is not given', () => {
    const html = render('default', { action: <button type="button">Save</button> });
    expect(html).not.toContain('Learn more.');
  });

  test('renders no docs link and no action content when neither is given', () => {
    const html = render('default', {});
    expect(html).not.toContain('Learn more.');
    expect(html).not.toContain('Save');
  });
});

describe('CustomizeSectionWrapper heading — fill mode', () => {
  test('renders the docs link before the action when both are given', () => {
    const html = render('fill', {
      docs: 'https://example.com',
      action: <button type="button">Save</button>,
    });
    expect(html).toContain('Learn more.');
    expect(html).toContain('Save');
    expect(html.indexOf('Learn more.')).toBeLessThan(html.indexOf('Save'));
  });

  test('renders the docs link when there is no action', () => {
    const html = render('fill', { docs: 'https://example.com' });
    expect(html).toContain('Learn more.');
  });

  test('renders no docs link when docs is not given', () => {
    const html = render('fill', { action: <button type="button">Save</button> });
    expect(html).not.toContain('Learn more.');
  });

  test('renders no docs link and no action content when neither is given', () => {
    const html = render('fill', {});
    expect(html).not.toContain('Learn more.');
    expect(html).not.toContain('Save');
  });
});
