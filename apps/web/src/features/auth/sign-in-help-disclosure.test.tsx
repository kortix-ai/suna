import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { SignInHelpDisclosure } from './sign-in-help-disclosure';

describe('SignInHelpDisclosure', () => {
  test('renders an accessible compact sign-in help trigger', () => {
    const html = renderToStaticMarkup(<SignInHelpDisclosure />);

    expect(html).toContain('Sign-in help');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls=');
    expect(html).toContain('h-10');
  });

  test('renders the helpful sentence when expanded', () => {
    const html = renderToStaticMarkup(<SignInHelpDisclosure defaultOpen />);

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('Use your work email');
    expect(html).toContain('we&#x27;ll route you automatically');
  });
});
