import { describe, expect, test } from 'bun:test';
import { NextResponse } from 'next/server';

import { redirectPreservingCookies } from './redirect-preserving-session';

describe('redirectPreservingCookies', () => {
  test('carries cookies staged on the source response onto the redirect', () => {
    const staged = NextResponse.next();
    staged.cookies.set('sb-kortix-auth-token', '', { path: '/', maxAge: 0 });
    staged.cookies.set('other-cookie', 'keep-me');

    const redirect = redirectPreservingCookies(
      new URL('https://kortix.local/auth?redirect=%2Fprojects'),
      staged.cookies,
    );

    expect(redirect.headers.get('location')).toBe('https://kortix.local/auth?redirect=%2Fprojects');
    expect(redirect.cookies.get('sb-kortix-auth-token')?.value).toBe('');
    expect(redirect.cookies.get('other-cookie')?.value).toBe('keep-me');
  });

  test('a plain NextResponse.redirect() drops those cookies — the exact regression this guards against', () => {
    const staged = NextResponse.next();
    staged.cookies.set('sb-kortix-auth-token', '', { path: '/', maxAge: 0 });

    const bareRedirect = NextResponse.redirect(new URL('https://kortix.local/auth'));

    expect(bareRedirect.cookies.get('sb-kortix-auth-token')).toBeUndefined();
  });

  test('no cookies staged on the source means no cookies on the redirect', () => {
    const staged = NextResponse.next();
    const redirect = redirectPreservingCookies(new URL('https://kortix.local/auth'), staged.cookies);
    expect(redirect.cookies.getAll()).toEqual([]);
  });
});
