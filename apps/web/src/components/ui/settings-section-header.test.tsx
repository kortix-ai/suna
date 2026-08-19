import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SettingsSectionHeader } from './settings-section-header';

describe('SettingsSectionHeader', () => {
  test('renders the title as an h2', () => {
    expect(renderToStaticMarkup(<SettingsSectionHeader title="Name and icon" />)).toContain(
      '>Name and icon</h2>',
    );
  });

  test('renders the description when given', () => {
    expect(
      renderToStaticMarkup(
        <SettingsSectionHeader title="Name" description="How this workspace appears." />,
      ),
    ).toContain('How this workspace appears.');
  });

  test('omits the description element entirely when not given', () => {
    expect(renderToStaticMarkup(<SettingsSectionHeader title="Name" />)).not.toContain('<p');
  });

  test('omits the action wrapper entirely when not given', () => {
    const out = renderToStaticMarkup(<SettingsSectionHeader title="Name" />);
    expect(out).not.toContain('sm:justify-end');
  });

  test('renders the action', () => {
    expect(
      renderToStaticMarkup(
        <SettingsSectionHeader title="Delete" action={<button type="button">Delete</button>} />,
      ),
    ).toContain('<button type="button">Delete</button>');
  });

  test('caps the description measure at the specified width', () => {
    expect(
      renderToStaticMarkup(<SettingsSectionHeader title="N" description="D" />),
    ).toContain('max-w-[410px]');
  });

  test('keeps the specified responsive layout on the outer row', () => {
    const out = renderToStaticMarkup(<SettingsSectionHeader title="N" />);
    for (const cls of ['sm:flex-row', 'sm:items-center', 'sm:justify-between']) {
      expect(out).toContain(cls);
    }
  });
});
