import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProfileTabView } from './profile-tab';

/** Section titles in document order, read from the h2s SettingsSectionHeader emits. */
const headings = (html: string): string[] =>
  [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1]);

const html = () => renderToStaticMarkup(<ProfileTabView />);

describe('ProfileTabView', () => {
  test('renders every section heading in order', () => {
    expect(headings(html())).toEqual([
      'Profile picture',
      'Name',
      'Email',
      'Two-factor authentication',
      'Delete account',
    ]);
  });

  test('the delete action is destructive', () => {
    expect(html()).toContain('destructive');
  });

  test('email is read-only', () => {
    expect(html()).toMatch(/<input[^>]*readonly/i);
  });

  test('renders no password-change control', () => {
    expect(html().toLowerCase()).not.toContain('password');
  });
});
