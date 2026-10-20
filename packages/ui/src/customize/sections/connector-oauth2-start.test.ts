import { describe, expect, test } from 'bun:test';

import { signInOrReason } from './connector-oauth2-start';

// KRTX-2185: Add account on an MCP server swallowed a failed sign-in start
// (`catch {}`) and opened credential entry with no reason, so an OAuth server
// looked like it wanted a pasted token.
describe('signInOrReason', () => {
  test('the consent URL when the sign-in starts', async () => {
    expect(await signInOrReason(async () => 'https://idp.example.com/authorize')).toEqual({
      url: 'https://idp.example.com/authorize',
      error: null,
    });
  });
  test('neither when the server has no one-click sign-in', async () => {
    expect(await signInOrReason(async () => null)).toEqual({ url: null, error: null });
  });
  test("the server's reason when the start fails", async () => {
    const result = await signInOrReason(async () => {
      throw new Error('OAuth2 client registration failed (400): invalid_redirect_uri');
    });
    expect(result).toEqual({
      url: null,
      error: 'OAuth2 client registration failed (400): invalid_redirect_uri',
    });
  });
});
