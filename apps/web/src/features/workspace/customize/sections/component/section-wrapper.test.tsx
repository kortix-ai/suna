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

describe('CustomizeSectionWrapper content column', () => {
  // The settings panel mounts Secrets, Channels, Schedules, Webhooks, Voice and
  // Upgrades through this wrapper, next to tabs that are `max-w-2xl`. It carried
  // `max-w-3xl` until 2026-08-12, so those six sat 96px wider than General and
  // the column jumped on every tab switch. Asserted on rendered markup, not on
  // source text, so it fails if the class is computed away.
  test('defaults to the settings panel column', () => {
    const html = render('default', {});
    expect(html).toContain('max-w-2xl');
    expect(html).not.toContain('max-w-3xl');
  });

  // The escape hatch `apps-view.tsx` uses for its 3-up card grid: twMerge drops
  // the base width when the caller passes one, so an opt-out is explicit and
  // greppable rather than a second default.
  test('a caller-supplied width replaces the default instead of stacking', () => {
    const html = renderToStaticMarkup(
      <CustomizeSectionWrapper title="Title" className="max-w-5xl">
        <div>Body</div>
      </CustomizeSectionWrapper>,
    );
    expect(html).toContain('max-w-5xl');
    expect(html).not.toContain('max-w-2xl');
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
